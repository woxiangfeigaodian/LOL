'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { server, buildOutcome, drawSpies } = require('../server.js');

let base = '';

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(path, body) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

/* ------------------------- 计票规则 ------------------------- */

test('本队内鬼那一票不计入本队（他投的是对面队伍）', () => {
  const o = buildOutcome({
    team: 'A',
    spy: 3,
    votes: { 1: 3, 2: 3, 3: 1, 4: 3, 5: 3 },
  });
  assert.equal(o.verdict, 'villagers');
  assert.equal(o.reason, 'caught');
  assert.equal(o.counts[3], 4);
  assert.equal(o.counts[1], 0, '内鬼就算硬投本队，那一票也不算');
  assert.equal(o.countedVotes, 4);
});

test('对面内鬼猜过来的那一票计入本队，一队共 5 票', () => {
  const o = buildOutcome({
    team: 'A',
    spy: 3,
    // 3 号是 A 队内鬼（去猜 8 号）；8 号是 B 队内鬼，猜 3 号
    votes: { 1: 3, 2: 3, 4: 3, 5: 3, 3: 8, 8: 3 },
  });
  assert.equal(o.counts[3], 5, 'A 队平民 4 票 + B 队内鬼猜过来 1 票');
  assert.equal(o.countedVotes, 5);
  assert.equal(o.verdict, 'villagers');
  assert.equal(o.reason, 'caught');
});

test('对面内鬼那一票能打破平票，把内鬼顶成唯一最高票', () => {
  const o = buildOutcome({
    team: 'A',
    spy: 3,
    // A 队平民 2:2 平票；B 队内鬼正好猜中 3 号，于是 3 号变成唯一最高票
    votes: { 1: 3, 2: 3, 4: 5, 5: 5, 3: 8, 8: 3 },
  });
  assert.equal(o.counts[3], 3, '本队 2 票 + 对面内鬼 1 票');
  assert.equal(o.counts[5], 2);
  assert.equal(o.topCount, 3);
  assert.deepEqual(o.leaders, [3]);
  assert.equal(o.reason, 'caught');
});

test('平票时内鬼胜出', () => {
  const o = buildOutcome({
    team: 'A',
    spy: 5,
    votes: { 1: 3, 2: 3, 3: 4, 4: 4, 5: 1 },
  });
  assert.equal(o.verdict, 'spy');
  assert.equal(o.reason, 'tie');
  assert.deepEqual(o.leaders, [3, 4]);
});

test('最高票是平民时内鬼胜出', () => {
  const o = buildOutcome({
    team: 'A',
    spy: 5,
    votes: { 1: 3, 2: 3, 3: 3, 4: 4, 5: 1 },
  });
  assert.equal(o.verdict, 'spy');
  assert.equal(o.reason, 'wrong_person');
});

test('无人投票时内鬼胜出', () => {
  const o = buildOutcome({ team: 'A', spy: 2, votes: {} });
  assert.equal(o.verdict, 'spy');
  assert.equal(o.reason, 'no_votes');
  assert.equal(o.countedVotes, 0);
});

test('B 队计票与 A 队一致', () => {
  const o = buildOutcome({
    team: 'B',
    spy: 7,
    votes: { 6: 7, 7: 6, 8: 7, 9: 7, 10: 7 },
  });
  assert.equal(o.verdict, 'villagers');
  assert.equal(o.counts[7], 4);
  assert.equal(o.counts[6], 0);
});

test('内鬼把票打到对面队伍时，本队计票完全不受影响', () => {
  const o = buildOutcome({
    team: 'A',
    spy: 3,
    votes: { 1: 3, 2: 3, 3: 8, 4: 3, 5: 3 }, // 3 号是内鬼，票打向对面队伍的 8 号
  });
  assert.equal(o.verdict, 'villagers');
  assert.equal(o.counts[3], 4);
  assert.equal(o.countedVotes, 4);
  assert.equal(o.detail.length, 4, '跨队的内鬼票不进本队投票明细');
});

test('随机抽内鬼：每队各一名且不越界', () => {
  for (let i = 0; i < 300; i += 1) {
    const spies = drawSpies();
    assert.ok(spies.A >= 1 && spies.A <= 5, `A 队内鬼越界：${spies.A}`);
    assert.ok(spies.B >= 6 && spies.B <= 10, `B 队内鬼越界：${spies.B}`);
  }
});

/* ------------------------- 完整一局 ------------------------- */

test('完整一局：身份只下发本人、队内投票、结算、开新一轮', async () => {
  const players = [];

  const host = await call('/api/rooms', { name: 'P1', seat: 1 });
  assert.equal(host.status, 200);
  players.push({ token: host.data.token, seat: host.data.seat });
  const code = host.data.code;

  for (let seat = 2; seat <= 10; seat += 1) {
    const res = await call('/api/join', { code, name: `P${seat}`, seat });
    assert.equal(res.status, 200, `座位 ${seat} 加入失败`);
    players.push({ token: res.data.token, seat: res.data.seat });
  }

  const lobbyState = await call(`/api/state?token=${players[0].token}`);
  assert.equal(lobbyState.data.state.phase, 'lobby');
  assert.equal(lobbyState.data.state.myRole, null);
  assert.equal(lobbyState.data.state.spies, null);
  assert.equal(lobbyState.data.state.occupiedCount, 10);

  const forbidden = await call('/api/action', { token: players[3].token, action: 'start_round' });
  assert.equal(forbidden.status, 403, '非房主不能开局');

  const started = await call('/api/action', { token: players[0].token, action: 'start_round' });
  assert.equal(started.status, 200);
  assert.equal(started.data.state.phase, 'reveal');
  assert.equal(started.data.state.round, 1);

  const spies = { A: null, B: null };
  let spyCount = 0;
  for (const player of players) {
    const res = await call(`/api/state?token=${player.token}`);
    const state = res.data.state;
    assert.equal(state.seat, player.seat);
    assert.equal(state.spies, null, '看身份阶段绝不能下发全员身份');
    assert.equal(state.outcome, null, '还没结算就不该有票数');
    assert.ok(state.myRole === 'spy' || state.myRole === 'villager');
    for (const seat of state.seats) {
      assert.equal(seat.role, undefined, '座位列表里不能带角色字段');
    }
    if (state.myRole === 'spy') {
      spyCount += 1;
      spies[state.team] = state.seat;
    }
  }
  assert.equal(spyCount, 2, '全场应该正好两名内鬼');
  assert.ok(spies.A >= 1 && spies.A <= 5);
  assert.ok(spies.B >= 6 && spies.B <= 10);

  for (const player of players) {
    await call('/api/action', { token: player.token, action: 'confirm_identity' });
  }

  const voting = await call('/api/action', { token: players[0].token, action: 'start_voting' });
  assert.equal(voting.data.state.phase, 'voting');

  const crossTeam = await call('/api/action', { token: players[0].token, action: 'vote', target: 7 });
  assert.equal(crossTeam.status, 400, '不能投别的队伍');

  const selfVote = await call('/api/action', { token: players[0].token, action: 'vote', target: 1 });
  assert.equal(selfVote.status, 400, '不能投给自己');

  const midVote = await call(`/api/state?token=${players[0].token}`);
  assert.equal(midVote.data.state.voteTargets.length, 4, '本队除自己外应有 4 个候选人');
  assert.equal(midVote.data.state.outcome, null, '投票过程中不能泄露票数');

  // 内鬼不能投本队，要去对面 5 个人里猜谁是对面的内鬼
  const spyPlayers = players.filter((p) => p.seat === spies.A || p.seat === spies.B);
  const villagerPlayers = players.filter((p) => p.seat !== spies.A && p.seat !== spies.B);
  assert.equal(spyPlayers.length, 2);
  for (const player of spyPlayers) {
    const myTeam = player.seat <= 5 ? 'A' : 'B';
    const ownTeamMate = (myTeam === 'A' ? [1, 2, 3, 4, 5] : [6, 7, 8, 9, 10]).find(
      (s) => s !== player.seat,
    );
    const rejected = await call('/api/action', {
      token: player.token,
      action: 'vote',
      target: ownTeamMate,
    });
    assert.equal(rejected.status, 400, '内鬼不能投本队的人');

    const spyView = await call(`/api/state?token=${player.token}`);
    assert.equal(spyView.data.state.isSpyBallot, true);
    assert.equal(spyView.data.state.spies, null, '内鬼也拿不到全员身份');
    assert.equal(spyView.data.state.voteTargets.length, 5, '内鬼的候选是对方队伍 5 人');
    assert.ok(
      spyView.data.state.voteTargets.every((t) => (t.seat <= 5 ? 'A' : 'B') !== myTeam),
      '内鬼只会看到对面队伍的候选人',
    );

    const opponentSpy = myTeam === 'A' ? spies.B : spies.A;
    const guess = await call('/api/action', {
      token: player.token,
      action: 'vote',
      target: opponentSpy,
    });
    assert.equal(guess.status, 200, '内鬼可以在对面队伍里猜一个');
    assert.equal(guess.data.state.myVoteTarget, opponentSpy, '内鬼看得到自己猜的是谁');
  }
  const villagerView = await call(`/api/state?token=${villagerPlayers[0].token}`);
  assert.equal(villagerView.data.state.votesSubmittedCount, 2, '两名内鬼投完后计为 2 票');

  for (const player of villagerPlayers) {
    const team = player.seat <= 5 ? 'A' : 'B';
    const res = await call('/api/action', { token: player.token, action: 'vote', target: spies[team] });
    assert.equal(res.status, 200, `座位 ${player.seat} 投票失败`);
  }

  const finished = await call(`/api/state?token=${players[0].token}`);
  const state = finished.data.state;
  assert.equal(state.phase, 'result', '全员投完后应自动结算');
  assert.equal(state.outcome.A.verdict, 'villagers');
  assert.equal(state.outcome.B.verdict, 'villagers');
  assert.equal(state.outcome.A.counts[spies.A], 5, 'A 队平民 4 票 + B 队内鬼猜过来 1 票');
  assert.equal(state.outcome.B.counts[spies.B], 5);
  assert.equal(state.outcome.A.countedVotes, 5, '每队 5 票：本队平民 4 票 + 对面内鬼 1 票');
  assert.equal(state.outcome.B.countedVotes, 5);
  assert.deepEqual(state.spies, spies, '结算后才公开内鬼');

  // 内鬼那一票：猜对面队伍的人，并算进对面队伍的票数
  assert.equal(state.outcome.ballots.length, 10, '十个人的票都要有记录');
  const spyBallotA = state.outcome.ballots.find((b) => b.voter === spies.A);
  const spyBallotB = state.outcome.ballots.find((b) => b.voter === spies.B);
  assert.equal(spyBallotA.bySpy, true);
  assert.equal(spyBallotA.crossTeam, true);
  assert.equal(spyBallotA.target, spies.B, 'A 队内鬼猜的是 B 队内鬼');
  assert.equal(spyBallotA.countsIn, 'B', 'A 队内鬼那一票算进 B 队');
  assert.equal(spyBallotB.target, spies.A, 'B 队内鬼猜的是 A 队内鬼');
  assert.equal(spyBallotB.countsIn, 'A', 'B 队内鬼那一票算进 A 队');
  assert.equal(state.outcome.ballots.filter((b) => b.countsIn === 'A').length, 5, 'A 队共 5 票');
  assert.equal(state.outcome.ballots.filter((b) => b.countsIn === 'B').length, 5, 'B 队共 5 票');

  // 历史战绩
  assert.equal(state.history.length, 1, '结算后应写入一条历史战绩');
  assert.equal(state.history[0].round, 1);
  assert.equal(state.history[0].A.spy.seat, spies.A);
  assert.equal(state.history[0].B.spy.seat, spies.B);
  assert.equal(state.history[0].A.reason, 'caught');
  assert.equal(state.history[0].B.reason, 'caught', '这一局两队都全员投了内鬼');
  assert.equal(state.history[0].ballots.length, 10);

  const lateVote = await call('/api/action', { token: players[1].token, action: 'vote', target: spies.A });
  assert.equal(lateVote.status, 409, '结算后不能再投票');

  const nextRound = await call('/api/action', { token: players[0].token, action: 'start_round' });
  assert.equal(nextRound.data.state.phase, 'reveal');
  assert.equal(nextRound.data.state.round, 2);
  assert.equal(nextRound.data.state.outcome, null);
  assert.equal(nextRound.data.state.spies, null);
  assert.equal(nextRound.data.state.myVoteTarget, null);
  assert.equal(nextRound.data.state.confirmedCount, 0);
  assert.equal(nextRound.data.state.history.length, 1, '新一轮里历史战绩依然可查');
});

test('伪造令牌拿不到任何房间状态', async () => {
  const res = await call('/api/state?token=deadbeef');
  assert.equal(res.status, 404);
  assert.equal(res.data.error, 'SESSION_GONE');
});

test('边界情况：满员、重复座位、开局后加入、看身份阶段踢人、房主退出', async () => {
  const host = await call('/api/rooms', { name: '房主', seat: 1 });
  const code = host.data.code;

  const second = await call('/api/join', { code, name: '二号', seat: 2 });
  assert.equal(second.status, 200);

  // 座位被占 / 房间码不存在
  const dupSeat = await call('/api/join', { code, name: '抢座', seat: 1 });
  assert.equal(dupSeat.status, 409);
  const badCode = await call('/api/join', { code: '0000', name: '迷路的', seat: 3 });
  assert.equal(badCode.status, 404);

  // 人没到齐不能开局
  const early = await call('/api/action', { token: host.data.token, action: 'start_round' });
  assert.equal(early.status, 409);
  assert.match(early.data.error, /10 名玩家/);

  // 补齐 10 人后开局，此时新人不能插进来
  const tokens = [host.data.token, second.data.token];
  for (let seat = 3; seat <= 10; seat += 1) {
    const res = await call('/api/join', { code, name: `P${seat}`, seat });
    tokens.push(res.data.token);
  }
  await call('/api/action', { token: tokens[0], action: 'start_round' });
  const latecomer = await call('/api/join', { code, name: '迟到', seat: null });
  assert.equal(latecomer.status, 409);
  assert.match(latecomer.data.error, /已经开始了/);

  // 房主不能在「看身份」阶段清空自己的座位
  const selfKick = await call('/api/action', { token: tokens[0], action: 'clear_seat', seat: 1 });
  assert.equal(selfKick.status, 400);

  // 枪毙一个座位会作废本轮并退回大厅
  const kicked = await call('/api/action', { token: tokens[0], action: 'clear_seat', seat: 7 });
  assert.equal(kicked.status, 200);
  assert.equal(kicked.data.state.phase, 'lobby');
  assert.equal(kicked.data.state.occupiedCount, 9);
  assert.equal(kicked.data.state.myRole, null);

  // 房主退出后，房主身份自动移交给还在座位上的人
  const left = await call('/api/action', { token: tokens[0], action: 'leave' });
  assert.equal(left.status, 200);
  const next = await call(`/api/state?token=${tokens[1]}`);
  assert.equal(next.data.state.isHost, true, '房主退出后应自动移交');

  // 退出后的旧令牌失效
  const orphan = await call(`/api/state?token=${tokens[0]}`);
  assert.equal(orphan.status, 404);
});
