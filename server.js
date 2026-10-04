'use strict';

/**
 * 内鬼模式 · 房间服务
 *
 * 零依赖：只用 Node 内置模块（Node >= 18）。
 * 核心原则：全部身份只存在服务端内存里，接口只把「请求者自己的身份」下发给他本人。
 * 轮询方案，不用 WebSocket —— 10 人的牌局 1~2 秒拉一次状态完全够用。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 6 * 60 * 60 * 1000);
const SEAT_COUNT = 10;
const TEAM_SIZE = SEAT_COUNT / 2;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ROOMS = 500;
const HISTORY_LIMIT = 30;

const MODE_CLASSIC = 'classic'; // 每队 1 名内鬼（沿用原规则）
const MODE_MULTI = 'multi'; // 每队随机 1~5 名内鬼，两队数量相同

/** 房间模式，缺省按经典模式处理。 */
function normalizeMode(mode) {
  return mode === MODE_MULTI ? MODE_MULTI : MODE_CLASSIC;
}

/** @type {Map<string, object>} */
const rooms = new Map();

/* ------------------------------------------------------------------ *
 * 纯逻辑部分（可单独测试，见 test/）
 * ------------------------------------------------------------------ */

function seatsOfTeam(team) {
  return team === 'A' ? [1, 2, 3, 4, 5] : [6, 7, 8, 9, 10];
}

function teamOf(seat) {
  return seat <= TEAM_SIZE ? 'A' : 'B';
}

/** 从一支队伍里随机抽 count 个不重复的座位，升序返回。 */
function pickSeats(team, count) {
  const pool = seatsOfTeam(team).slice();
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).sort((a, b) => a - b);
}

/**
 * 经典模式：每队各随机一名内鬼，连续当内鬼是允许的，不做任何排除。
 * 多内鬼模式：两队各随机 2~5 名内鬼，两边数量相同，同队不重复。
 */
function drawSpies(mode = MODE_CLASSIC) {
  if (mode === MODE_MULTI) {
    const count = crypto.randomInt(2, TEAM_SIZE + 1);
    return { A: pickSeats('A', count), B: pickSeats('B', count) };
  }
  const pick = (team) => {
    const seats = seatsOfTeam(team);
    return seats[crypto.randomInt(0, seats.length)];
  };
  return { A: pick('A'), B: pick('B') };
}

/** 取出某队的内鬼座位数组（经典模式存单个座位号，多内鬼模式存数组）。 */
function spySeatsOfTeam(spies, team) {
  const value = spies ? spies[team] : null;
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function isSpySeat(room, seat) {
  return spySeatsOfTeam(room.spies, teamOf(seat)).includes(seat);
}

/**
 * 统计一支队伍的投票结果。
 *
 * 规则：
 *  - 平民只能投本队的人；内鬼不能投本队，改成猜对面队伍的内鬼；
 *  - 所以一支队伍的票数 = 本队平民的 4 票 + 对面内鬼猜过来的 1 票，共 5 票；
 *  - 本队内鬼那一票算在对面队伍头上，不计入本队；
 *  - 唯一最高票且正好是内鬼 -> 平民胜出；
 *  - 平票 / 最高票是平民 / 无人投票 -> 内鬼胜出。
 */
function buildOutcome({ votes, spy, team }) {
  const seats = seatsOfTeam(team);
  const counts = new Map(seats.map((s) => [s, 0]));
  const detail = [];

  for (const key of Object.keys(votes)) {
    const voter = Number(key);
    const target = Number(votes[key]);
    if (voter === spy) continue; // 本队内鬼那一票算在对面队伍头上
    if (!counts.has(target)) continue; // 不是投给本队的，与本队无关
    counts.set(target, counts.get(target) + 1);
    detail.push({ voter, target });
  }

  let topCount = 0;
  for (const seat of seats) topCount = Math.max(topCount, counts.get(seat));
  const leaders = seats.filter((s) => counts.get(s) === topCount);

  let verdict;
  let reason;
  if (topCount > 0 && leaders.length === 1 && leaders[0] === spy) {
    verdict = 'villagers';
    reason = 'caught';
  } else if (topCount === 0) {
    verdict = 'spy';
    reason = 'no_votes';
  } else if (leaders.length > 1) {
    verdict = 'spy';
    reason = 'tie';
  } else {
    verdict = 'spy';
    reason = 'wrong_person';
  }

  return {
    team,
    spy,
    counts: Object.fromEntries(counts),
    topCount,
    leaders,
    countedVotes: detail.length,
    detail,
    verdict,
    reason,
  };
}

/**
 * 多内鬼模式的计票：每人 2 票，平民投本队、内鬼猜对面（票计入对面队伍）。
 * 所以每队票数 = 本队平民每人 2 票 + 对面内鬼每人 2 票，全员投完时恒为 10 票。
 * topSpies = 得票最高的内鬼，只作为结算展示（App 不判胜负、不算红包）。
 */
function buildMultiOutcome({ votes, spies, team }) {
  const seats = seatsOfTeam(team);
  const spySet = new Set(spies);
  const counts = new Map(seats.map((s) => [s, 0]));
  const detail = [];

  for (const key of Object.keys(votes)) {
    const voter = Number(key);
    const raw = votes[voter];
    const targets = Array.isArray(raw) ? raw : [raw];
    for (const value of targets) {
      const target = Number(value);
      if (!counts.has(target)) continue; // 只有投给本队的票才算
      counts.set(target, counts.get(target) + 1);
      detail.push({ voter, target });
    }
  }

  let topCount = 0;
  for (const seat of seats) topCount = Math.max(topCount, counts.get(seat));
  const leaders = seats.filter((s) => counts.get(s) === topCount);
  const topSpies = topCount > 0 ? leaders.filter((s) => spySet.has(s)) : [];

  return {
    team,
    spies: spies.slice().sort((a, b) => a - b),
    counts: Object.fromEntries(counts),
    topCount,
    leaders,
    topSpies,
    countedVotes: detail.length,
    detail,
  };
}

/**
 * 把 room.votes 摊平成一条条「谁投给谁」。
 * 经典模式每人一条，多内鬼模式每人两条（两票）。
 */
function buildBallots(room) {
  const entries = [];
  for (const key of Object.keys(room.votes)) {
    const voter = Number(key);
    const raw = room.votes[voter];
    const targets = Array.isArray(raw) ? raw : [raw];
    for (const value of targets) {
      const target = Number(value);
      entries.push({
        voter,
        voterName: nameOfSeat(room, voter),
        target,
        targetName: nameOfSeat(room, target),
        bySpy: isSpySeat(room, voter),
        crossTeam: teamOf(voter) !== teamOf(target),
        // 一票算进哪支队伍，就看它投给了哪支队伍的人
        countsIn: teamOf(target),
      });
    }
  }
  return entries.sort((a, b) => a.voter - b.voter || a.target - b.target);
}

function buildRoundOutcome(room) {
  const ballots = buildBallots(room);

  const multi = room.mode === MODE_MULTI;
  const outcome = multi
    ? {
        A: buildMultiOutcome({ votes: room.votes, spies: spySeatsOfTeam(room.spies, 'A'), team: 'A' }),
        B: buildMultiOutcome({ votes: room.votes, spies: spySeatsOfTeam(room.spies, 'B'), team: 'B' }),
      }
    : {
        A: buildOutcome({ votes: room.votes, spy: room.spies.A, team: 'A' }),
        B: buildOutcome({ votes: room.votes, spy: room.spies.B, team: 'B' }),
      };

  return { round: room.round, mode: room.mode, ballots, A: outcome.A, B: outcome.B };
}

/**
 * 经典模式的红包结算清单（单倍，不含「被投出双倍」）。
 *
 * 内鬼所在队赢了，或者内鬼被投出：内鬼发 5 个红包（共 5 元），
 * 由「己方平民 + 对方内鬼」共 5 人领取，一人 1 元。
 * 内鬼所在队输了且没被投出：内鬼免罚，己方没投内鬼的平民每人给他 1 元。
 */
function buildClassicSettlement(room) {
  if (!room.matchWinner || !room.outcome) return null;

  const entries = [];
  for (const team of ['A', 'B']) {
    const other = team === 'A' ? 'B' : 'A';
    const outcome = room.outcome[team];
    const spy = outcome.spy;
    const caught = outcome.reason === 'caught'; // 唯一最高票正好是内鬼
    const teamWon = room.matchWinner === team;
    const spyInfo = { seat: spy, name: nameOfSeat(room, spy) };

    if (teamWon || caught) {
      const receivers = seatsOfTeam(team)
        .filter((s) => s !== spy && room.seats[s - 1])
        .map((s) => ({ seat: s, name: nameOfSeat(room, s) }));
      const enemySpy = room.outcome[other].spy;
      if (room.seats[enemySpy - 1]) {
        receivers.push({ seat: enemySpy, name: nameOfSeat(room, enemySpy) });
      }
      entries.push({
        team,
        spy: spyInfo,
        caught,
        teamWon,
        action: 'pay',
        packets: 5,
        amount: 5,
        perPacket: 1,
        receivers,
      });
      continue;
    }

    // 输了且没被投出：免罚；没投中他的平民每人给他 1 元（弃权也算没投中）
    const payers = [];
    for (const seat of seatsOfTeam(team)) {
      if (seat === spy || !room.seats[seat - 1]) continue;
      const hasVote = Object.prototype.hasOwnProperty.call(room.votes, seat);
      if (hasVote && Number(room.votes[seat]) === spy) continue;
      payers.push({ seat, name: nameOfSeat(room, seat) });
    }
    entries.push({
      team,
      spy: spyInfo,
      caught,
      teamWon,
      action: 'collect',
      amount: payers.length,
      perPerson: 1,
      payers,
    });
  }

  return { winner: room.matchWinner, packets: 5, perPacket: 1, entries };
}

/**
 * 多内鬼模式的红包结算清单（单倍，平民不参与发红包）。
 *
 * 内鬼所在队赢了，或者该内鬼被投出（本队最高票里的内鬼，可并列）：
 * 每个内鬼发 5 个红包，总额 = 6 - 内鬼数量（5 人 1 元 / 4 人 2 元 / 3 人 3 元 / 2 人 4 元），
 * 由「己方平民 + 对方内鬼」共 5 人领取。
 * 内鬼所在队输了且没被投出：该内鬼免罚，什么都不用发。
 */
function buildMultiSettlement(room) {
  if (!room.matchWinner || !room.outcome) return null;
  const spyCount = spySeatsOfTeam(room.spies, 'A').length;
  const perSpy = 6 - spyCount;
  const entries = [];

  for (const team of ['A', 'B']) {
    const other = team === 'A' ? 'B' : 'A';
    const outcome = room.outcome[team];
    const teamWon = room.matchWinner === team;
    const topSet = new Set(outcome.topSpies || []);
    const enemySpies = spySeatsOfTeam(room.spies, other);

    for (const seat of outcome.spies) {
      const caught = topSet.has(seat);
      const spyInfo = { seat, name: nameOfSeat(room, seat) };
      if (!teamWon && !caught) {
        entries.push({ team, spy: spyInfo, caught, teamWon, action: 'free' });
        continue;
      }
      const receivers = seatsOfTeam(team)
        .filter((s) => !outcome.spies.includes(s) && room.seats[s - 1])
        .map((s) => ({ seat: s, name: nameOfSeat(room, s) }));
      for (const enemySpy of enemySpies) {
        if (room.seats[enemySpy - 1]) {
          receivers.push({ seat: enemySpy, name: nameOfSeat(room, enemySpy) });
        }
      }
      entries.push({
        team,
        spy: spyInfo,
        caught,
        teamWon,
        action: 'pay',
        packets: 5,
        amount: perSpy,
        receivers,
      });
    }
  }

  return { winner: room.matchWinner, mode: MODE_MULTI, spyCount, perSpy, packets: 5, entries };
}

/** 按房间模式分发红包结算。 */
function buildSettlement(room) {
  if (!room.matchWinner || !room.outcome) return null;
  return room.mode === MODE_MULTI ? buildMultiSettlement(room) : buildClassicSettlement(room);
}

function nameOfSeat(room, seat) {
  const seatNumber = Number(seat);
  const occupant = room.seats[seatNumber - 1];
  return occupant ? occupant.name : `${seatNumber} 号（已离开）`;
}

/**
 * 把一轮的结果压成历史战绩。名字在这里就固化下来，
 * 之后有人换座位或者退房，回看历史依然是当时的名字。
 */
function archiveRound(room) {
  const multi = room.mode === MODE_MULTI;
  const pack = multi
    ? (outcome) => ({
        team: outcome.team,
        spies: outcome.spies.map((seat) => ({ seat, name: nameOfSeat(room, seat) })),
        topSpies: outcome.topSpies.map((seat) => ({ seat, name: nameOfSeat(room, seat) })),
        topCount: outcome.topCount,
        countedVotes: outcome.countedVotes,
      })
    : (outcome) => ({
        team: outcome.team,
        verdict: outcome.verdict,
        reason: outcome.reason,
        topCount: outcome.topCount,
        countedVotes: outcome.countedVotes,
        spy: { seat: outcome.spy, name: nameOfSeat(room, outcome.spy) },
      });
  return {
    round: room.round,
    mode: room.mode,
    at: Date.now(),
    matchWinner: room.matchWinner || null,
    settlement: room.settlement || null,
    A: pack(room.outcome.A),
    B: pack(room.outcome.B),
    ballots: room.outcome.ballots,
    seats: room.seats.map((occupant, index) => ({
      seat: index + 1,
      name: occupant ? occupant.name : null,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * 房间状态
 * ------------------------------------------------------------------ */

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function newRoomCode() {
  let code;
  do {
    code = String(crypto.randomInt(1000, 10000));
  } while (rooms.has(code));
  return code;
}

function createRoom(name, wantedSeat, mode) {
  if (rooms.size >= MAX_ROOMS) pruneRooms(true);
  const code = newRoomCode();
  const room = {
    code,
    mode: normalizeMode(mode),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'lobby', // lobby | reveal | voting | result
    round: 0,
    hostToken: null,
    seats: new Array(SEAT_COUNT).fill(null), // 下标 0 = 1 号座位
    spies: null,
    votes: {},
    confirmed: new Set(),
    outcome: null,
    matchWinner: null, // 'A' | 'B'，房主录入的这局真实比赛赢家
    settlement: null, // 比赛结果 + 投票都齐了之后生成的红包清单
    history: [],
  };
  rooms.set(code, room);

  const seat = takeSeat(room, name, wantedSeat);
  room.hostToken = room.seats[seat - 1].token;
  touch(room);
  return { room, seat, token: room.seats[seat - 1].token };
}

function takeSeat(room, name, wantedSeat) {
  const seat = pickSeat(room, wantedSeat);
  if (!seat) throw new HttpError(409, '房间已经坐满了');
  room.seats[seat - 1] = {
    name: String(name || '').trim().slice(0, 12) || `${seat} 号`,
    token: newToken(),
    joinedAt: Date.now(),
  };
  return seat;
}

function pickSeat(room, wantedSeat) {
  const wanted = Number(wantedSeat);
  if (Number.isInteger(wanted) && wanted >= 1 && wanted <= SEAT_COUNT) {
    if (!room.seats[wanted - 1]) return wanted;
    throw new HttpError(409, `${wanted} 号座位已经有人了`);
  }
  for (let s = 1; s <= SEAT_COUNT; s += 1) if (!room.seats[s - 1]) return s;
  return null;
}

function findRoomByToken(token) {
  if (!token) return null;
  for (const room of rooms.values()) {
    const index = room.seats.findIndex((seat) => seat && seat.token === token);
    if (index !== -1) return { room, seat: index + 1 };
  }
  return null;
}

function occupiedCount(room) {
  return room.seats.filter(Boolean).length;
}

function isFull(room) {
  return occupiedCount(room) === SEAT_COUNT;
}

function touch(room) {
  room.updatedAt = Date.now();
}

function pruneRooms(force = false) {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = now - room.updatedAt;
    if (idle > ROOM_TTL_MS || (force && rooms.size > MAX_ROOMS)) rooms.delete(code);
    if (!force && rooms.size <= MAX_ROOMS) break;
  }
}

/* ------------------------------------------------------------------ *
 * 对局流程
 * ------------------------------------------------------------------ */

function startRound(room) {
  if (!isFull(room)) throw new HttpError(409, '需要 10 名玩家全部就位');
  room.round += 1;
  room.spies = drawSpies(room.mode);
  room.votes = {};
  room.confirmed = new Set();
  room.outcome = null;
  room.matchWinner = null;
  room.settlement = null;
  room.phase = 'reveal';
  touch(room);
}

function finishVoting(room) {
  room.outcome = buildRoundOutcome(room);
  if (room.matchWinner) room.settlement = buildSettlement(room);
  room.history.push(archiveRound(room));
  if (room.history.length > HISTORY_LIMIT) {
    room.history.splice(0, room.history.length - HISTORY_LIMIT);
  }
  room.phase = 'result';
  touch(room);
}

function everyoneVoted(room) {
  return room.seats.every(
    (seat, index) => !seat || Object.prototype.hasOwnProperty.call(room.votes, index + 1),
  );
}

function clearSeat(room, seatNumber, actorSeat) {
  const seat = Number(seatNumber);
  if (!Number.isInteger(seat) || seat < 1 || seat > SEAT_COUNT) throw new HttpError(400, '座位号不合法');
  if (seat === actorSeat) throw new HttpError(400, '不能清空自己的座位，请用「退出房间」');
  if (!room.seats[seat - 1]) throw new HttpError(404, '该座位本来就是空的');
  room.seats[seat - 1] = null;
  delete room.votes[seat];
  room.confirmed.delete(seat);
  if (room.phase === 'reveal') {
    // 身份已经发下去了，本轮作废，退回大厅重新开局
    room.phase = 'lobby';
    room.spies = null;
    room.votes = {};
    room.confirmed = new Set();
    room.matchWinner = null;
    room.settlement = null;
  }
  touch(room);
}

function transferHost(room) {
  const index = room.seats.findIndex(Boolean);
  room.hostToken = index === -1 ? null : room.seats[index].token;
}

function applyAction(room, seat, action, payload = {}) {
  const isHost = room.seats[seat - 1].token === room.hostToken;
  const requireHost = () => {
    if (!isHost) throw new HttpError(403, '只有房主能执行这个操作');
  };

  switch (action) {
    case 'start_round':
      requireHost();
      if (room.phase !== 'lobby' && room.phase !== 'result') throw new HttpError(409, '当前阶段不能开始新一轮');
      startRound(room);
      return;

    case 'confirm_identity':
      if (room.phase !== 'reveal') throw new HttpError(409, '还没到确认身份的阶段');
      room.confirmed.add(seat);
      touch(room);
      return;

    case 'start_voting':
      requireHost();
      if (room.phase !== 'reveal') throw new HttpError(409, '当前阶段不能进入投票');
      room.phase = 'voting';
      room.votes = {};
      touch(room);
      return;

    case 'vote': {
      if (room.phase !== 'voting') throw new HttpError(409, '现在不是投票阶段');

      if (room.mode === MODE_MULTI) {
        // 多内鬼模式：每人 2 票，一次提交，必须投给两个不同的人
        const targets = Array.isArray(payload.targets) ? payload.targets.map(Number) : [];
        if (targets.length !== 2 || targets.some((t) => !Number.isInteger(t))) {
          throw new HttpError(400, '要一次性选满 2 个人');
        }
        if (targets[0] === targets[1]) throw new HttpError(400, '两票不能投给同一个人');

        const iAmSpy = isSpySeat(room, seat);
        for (const target of targets) {
          if (target === seat) throw new HttpError(400, '不能投给自己');
          if (!room.seats[target - 1]) throw new HttpError(400, '该座位现在没有人');
          if (iAmSpy) {
            // 内鬼两票都投对面队伍，猜谁是对面的内鬼
            if (teamOf(target) === teamOf(seat)) throw new HttpError(400, '你是内鬼，只能猜对面队伍的人');
          } else if (teamOf(target) !== teamOf(seat)) {
            throw new HttpError(400, '只能投本队的人');
          }
        }

        room.votes[seat] = targets.slice().sort((a, b) => a - b);
        if (everyoneVoted(room)) finishVoting(room);
        else touch(room);
        return;
      }

      const target = Number(payload.target);
      if (!Number.isInteger(target)) throw new HttpError(400, '投票目标不合法');
      if (target === seat) throw new HttpError(400, '不能投给自己');
      if (!room.seats[target - 1]) throw new HttpError(400, '该座位现在没有人');

      const iAmSpy = isSpySeat(room, seat);
      if (iAmSpy) {
        // 内鬼不能投本队，改成在对面 5 人里猜谁是对面的内鬼
        if (teamOf(target) === teamOf(seat)) throw new HttpError(400, '你是内鬼，只能猜对面队伍的人');
      } else if (teamOf(target) !== teamOf(seat)) {
        throw new HttpError(400, '只能投本队的人');
      }

      room.votes[seat] = target;
      if (everyoneVoted(room)) finishVoting(room);
      else touch(room);
      return;
    }

    case 'end_voting':
      requireHost();
      if (room.phase !== 'voting') throw new HttpError(409, '现在不是投票阶段');
      finishVoting(room);
      return;

    case 'set_match_winner': {
      requireHost();
      if (room.phase === 'lobby') throw new HttpError(409, '还没开始本轮');
      // winner 允许为 null：撤回已录的比赛结果
      const winner = payload.winner === null ? null : payload.winner;
      if (winner !== 'A' && winner !== 'B' && winner !== null) throw new HttpError(400, '比赛结果不合法');
      room.matchWinner = winner;
      if (room.phase === 'result') {
        room.settlement = winner ? buildSettlement(room) : null;
        const last = room.history[room.history.length - 1];
        if (last && last.round === room.round) {
          last.matchWinner = room.matchWinner;
          last.settlement = room.settlement;
        }
      }
      touch(room);
      return;
    }

    case 'clear_seat':
      requireHost();
      if (room.phase !== 'lobby' && room.phase !== 'reveal' && room.phase !== 'result') {
        throw new HttpError(409, '投票进行中不能清空座位，可以先用「提前结束投票」');
      }
      clearSeat(room, payload.seat, seat);
      return;

    case 'back_to_lobby':
      requireHost();
      room.phase = 'lobby';
      room.spies = null;
      room.votes = {};
      room.confirmed = new Set();
      room.outcome = null;
      room.matchWinner = null;
      room.settlement = null;
      touch(room);
      return;

    case 'leave': {
      if (room.phase === 'voting') throw new HttpError(409, '投票进行中，请把票投完或让房主结束投票');
      const wasHost = isHost;
      room.seats[seat - 1] = null;
      delete room.votes[seat];
      room.confirmed.delete(seat);
      if (wasHost) transferHost(room);
      if (room.phase === 'reveal') {
        room.phase = 'lobby';
        room.spies = null;
        room.votes = {};
        room.confirmed = new Set();
        room.matchWinner = null;
        room.settlement = null;
      }
      touch(room);
      return;
    }

    default:
      throw new HttpError(400, `未知操作：${action}`);
  }
}

/* ------------------------------------------------------------------ *
 * 下发给单个玩家的状态（关键：只包含他自己的身份）
 * ------------------------------------------------------------------ */

function snapshotFor(room, seat, token) {
  const multi = room.mode === MODE_MULTI;
  const myTeam = teamOf(seat);
  const revealMyRole = room.phase !== 'lobby' && room.spies;
  const iAmSpy = Boolean(revealMyRole) && isSpySeat(room, seat);
  const myRole = revealMyRole ? (iAmSpy ? 'spy' : 'villager') : null;
  const showAll = room.phase === 'result';

  const seats = [];
  for (let s = 1; s <= SEAT_COUNT; s += 1) {
    const occupant = room.seats[s - 1];
    seats.push({
      seat: s,
      team: teamOf(s),
      occupied: Boolean(occupant),
      name: occupant ? occupant.name : null,
      isMe: s === seat,
      isHost: Boolean(occupant) && occupant.token === room.hostToken,
      confirmed: room.confirmed.has(s),
      hasVoted: Object.prototype.hasOwnProperty.call(room.votes, s),
    });
  }

  // 两种模式同一条逻辑：平民在自己队里选，内鬼去对面队里猜
  const targetTeam = iAmSpy ? (myTeam === 'A' ? 'B' : 'A') : myTeam;
  const voteTargets =
    room.phase === 'voting'
      ? seatsOfTeam(targetTeam)
          .filter((s) => s !== seat && room.seats[s - 1])
          .map((s) => ({ seat: s, name: room.seats[s - 1].name, team: targetTeam }))
      : [];

  return {
    code: room.code,
    mode: room.mode,
    phase: room.phase,
    round: room.round,
    seat,
    name: room.seats[seat - 1] ? room.seats[seat - 1].name : null,
    team: myTeam,
    isHost: token === room.hostToken,
    seats,
    occupiedCount: occupiedCount(room),
    confirmedCount: seats.filter((s) => s.occupied && s.confirmed).length,
    votesSubmittedCount: seats.filter((s) => s.occupied && s.hasVoted).length,
    myRole,
    isSpyBallot: iAmSpy,
    // 经典模式一票（数字），多内鬼模式两票（数组）
    myVoteTarget: !multi && Object.prototype.hasOwnProperty.call(room.votes, seat) ? room.votes[seat] : null,
    myVoteTargets: multi && Object.prototype.hasOwnProperty.call(room.votes, seat) ? room.votes[seat] : null,
    voteTargets,
    history: room.history.slice(-HISTORY_LIMIT),
    matchWinner: room.matchWinner, // 房主录入的比赛结果，公开信息
    // 只有结算之后才公开所有人的身份
    spies: showAll ? room.spies : null,
    outcome: showAll ? room.outcome : null,
    settlement: showAll ? room.settlement : null,
  };
}

/* ------------------------------------------------------------------ *
 * HTTP 层
 * ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        return resolve(JSON.parse(raw));
      } catch {
        return reject(new HttpError(400, '请求格式不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function serveStatic(res, pathname) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  const [file, type] = entry;
  fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('前端文件读取失败');
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
  return true;
}

async function handleApi(req, res, url) {
  const body = req.method === 'POST' ? await readBody(req) : {};

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const { room, seat, token } = createRoom(body.name, body.seat, body.mode);
    return sendJson(res, 200, { ok: true, code: room.code, mode: room.mode, seat, token });
  }

  if (req.method === 'GET' && url.pathname === '/api/rooms') {
    const room = rooms.get(String(url.searchParams.get('code') || '').trim());
    if (!room) throw new HttpError(404, '房间不存在或已过期');
    return sendJson(res, 200, {
      ok: true,
      code: room.code,
      mode: room.mode,
      phase: room.phase,
      seats: room.seats.map((occupant, index) => ({
        seat: index + 1,
        team: teamOf(index + 1),
        occupied: Boolean(occupant),
        name: occupant ? occupant.name : null,
      })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/join') {
    const code = String(body.code || '').trim();
    const room = rooms.get(code);
    if (!room) throw new HttpError(404, '房间不存在或已过期，检查一下房间码');
    if (room.phase !== 'lobby') throw new HttpError(409, '这局已经开始了，等这一轮结束再来');
    const seat = takeSeat(room, body.name, body.seat);
    touch(room);
    return sendJson(res, 200, { ok: true, code: room.code, seat, token: room.seats[seat - 1].token });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const token = url.searchParams.get('token');
    const found = findRoomByToken(token);
    if (!found) throw new HttpError(404, 'SESSION_GONE');
    return sendJson(res, 200, { ok: true, state: snapshotFor(found.room, found.seat, token) });
  }

  if (req.method === 'POST' && url.pathname === '/api/action') {
    const found = findRoomByToken(body.token);
    if (!found) throw new HttpError(404, 'SESSION_GONE');
    applyAction(found.room, found.seat, body.action, body);
    return sendJson(res, 200, { ok: true, state: snapshotFor(found.room, found.seat, body.token) });
  }

  throw new HttpError(404, '接口不存在');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, rooms: rooms.size, uptime: process.uptime() });
    }
    if (req.method === 'GET' && serveStatic(res, url.pathname)) return;
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[error]', req.method, req.url, err);
    sendJson(res, status, { ok: false, error: err.message || '服务器内部错误' });
  }
});

setInterval(() => pruneRooms(), 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`内鬼模式服务已启动： http://localhost:${PORT}`);
    console.log('把地址发给同局的朋友即可。公网访问需要部署到云主机，或用隧道工具临时穿透。');
  });
}

module.exports = {
  server,
  rooms,
  teamOf,
  seatsOfTeam,
  drawSpies,
  buildOutcome,
  buildMultiOutcome,
  buildRoundOutcome,
  createRoom,
  applyAction,
  snapshotFor,
  findRoomByToken,
  isSpySeat,
  MODE_CLASSIC,
  MODE_MULTI,
};
