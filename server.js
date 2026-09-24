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

/** 每队各随机一名内鬼。连续当内鬼是允许的，不做任何排除。 */
function drawSpies() {
  const pick = (team) => {
    const seats = seatsOfTeam(team);
    return seats[crypto.randomInt(0, seats.length)];
  };
  return { A: pick('A'), B: pick('B') };
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

function buildRoundOutcome(room) {
  const spies = room.spies;
  const ballots = Object.keys(room.votes)
    .map(Number)
    .sort((a, b) => a - b)
    .map((voter) => {
      const target = Number(room.votes[voter]);
      const bySpy = voter === spies.A || voter === spies.B;
      const crossTeam = teamOf(voter) !== teamOf(target);
      return {
        voter,
        voterName: nameOfSeat(room, voter),
        target,
        targetName: nameOfSeat(room, target),
        bySpy,
        crossTeam,
        // 一票算进哪支队伍，就看它投给了哪支队伍的人
        countsIn: teamOf(target),
      };
    });

  return {
    round: room.round,
    ballots,
    A: buildOutcome({ votes: room.votes, spy: spies.A, team: 'A' }),
    B: buildOutcome({ votes: room.votes, spy: spies.B, team: 'B' }),
  };
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
  const pack = (outcome) => ({
    team: outcome.team,
    verdict: outcome.verdict,
    reason: outcome.reason,
    topCount: outcome.topCount,
    countedVotes: outcome.countedVotes,
    spy: { seat: outcome.spy, name: nameOfSeat(room, outcome.spy) },
  });
  return {
    round: room.round,
    at: Date.now(),
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

function createRoom(name, wantedSeat) {
  if (rooms.size >= MAX_ROOMS) pruneRooms(true);
  const code = newRoomCode();
  const room = {
    code,
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
  room.spies = drawSpies();
  room.votes = {};
  room.confirmed = new Set();
  room.outcome = null;
  room.phase = 'reveal';
  touch(room);
}

function finishVoting(room) {
  room.outcome = buildRoundOutcome(room);
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
      const target = Number(payload.target);
      if (!Number.isInteger(target)) throw new HttpError(400, '投票目标不合法');
      if (target === seat) throw new HttpError(400, '不能投给自己');
      if (!room.seats[target - 1]) throw new HttpError(400, '该座位现在没有人');

      const iAmSpy = seat === room.spies.A || seat === room.spies.B;
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
  const myTeam = teamOf(seat);
  const revealMyRole = room.phase !== 'lobby' && room.spies;
  const myRole = revealMyRole ? (room.spies[myTeam] === seat ? 'spy' : 'villager') : null;
  const iAmSpy = Boolean(revealMyRole) && room.spies[myTeam] === seat;
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

  // 平民在自己队里选，内鬼在对面队里猜
  const targetTeam = iAmSpy ? (myTeam === 'A' ? 'B' : 'A') : myTeam;
  const voteTargets =
    room.phase === 'voting'
      ? seatsOfTeam(targetTeam)
          .filter((s) => s !== seat && room.seats[s - 1])
          .map((s) => ({ seat: s, name: room.seats[s - 1].name, team: targetTeam }))
      : [];

  return {
    code: room.code,
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
    myVoteTarget: Object.prototype.hasOwnProperty.call(room.votes, seat) ? room.votes[seat] : null,
    voteTargets,
    history: room.history.slice(-HISTORY_LIMIT),
    // 只有结算之后才公开所有人的身份
    spies: showAll ? room.spies : null,
    outcome: showAll ? room.outcome : null,
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
    const { room, seat, token } = createRoom(body.name, body.seat);
    return sendJson(res, 200, { ok: true, code: room.code, seat, token });
  }

  if (req.method === 'GET' && url.pathname === '/api/rooms') {
    const room = rooms.get(String(url.searchParams.get('code') || '').trim());
    if (!room) throw new HttpError(404, '房间不存在或已过期');
    return sendJson(res, 200, {
      ok: true,
      code: room.code,
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
  buildRoundOutcome,
  createRoom,
  applyAction,
  snapshotFor,
  findRoomByToken,
};
