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

test('内鬼被唯一最高票投出时平民胜出，且内鬼那一票作废', () => {
  const o = buildOutcome({
    team: 'A',
    spy: 3,
    votes: { 1: 3, 2: 3, 3: 1, 4: 3, 5: 3 },
  });
  assert.equal(o.verdict, 'villagers');
  assert.equal(o.reason, 'caught');
  assert.equal(o.counts[3], 4);
  assert.equal(o.counts[1], 0, '内鬼投出去的那一票不该计入 1 号');
  assert.equal(o.countedVotes, 4, '5 人里内鬼那一票作废，只剩 4 张有效票');
  assert.equal(o.detail.find((d) => d.voter === 3).counted, false);
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

  for (const player of players) {
    const team = player.seat <= 5 ? 'A' : 'B';
    const spy = spies[team];
    const fallback = team === 'A' ? (spy === 1 ? 2 : 1) : spy === 6 ? 7 : 6;
    const target = player.seat === spy ? fallback : spy;
    const res = await call('/api/action', { token: player.token, action: 'vote', target });
    assert.equal(res.status, 200, `座位 ${player.seat} 投票失败`);
  }

  const finished = await call(`/api/state?token=${players[0].token}`);
  const state = finished.data.state;
  assert.equal(state.phase, 'result', '全员投完后应自动结算');
  assert.equal(state.outcome.A.verdict, 'villagers');
  assert.equal(state.outcome.B.verdict, 'villagers');
  assert.equal(state.outcome.A.counts[spies.A], 4);
  assert.equal(state.outcome.B.counts[spies.B], 4);
  assert.equal(state.outcome.A.countedVotes, 4, '内鬼的票必须被排除');
  assert.equal(state.outcome.B.countedVotes, 4);
  assert.equal(state.outcome.A.detail.find((d) => d.voter === spies.A).counted, false);
  assert.deepEqual(state.spies, spies, '结算后才公开内鬼');

  const lateVote = await call('/api/action', { token: players[1].token, action: 'vote', target: spies.A });
  assert.equal(lateVote.status, 409, '结算后不能再投票');

  const nextRound = await call('/api/action', { token: players[0].token, action: 'start_round' });
  assert.equal(nextRound.data.state.phase, 'reveal');
  assert.equal(nextRound.data.state.round, 2);
  assert.equal(nextRound.data.state.outcome, null);
  assert.equal(nextRound.data.state.spies, null);
  assert.equal(nextRound.data.state.myVoteTarget, null);
  assert.equal(nextRound.data.state.confirmedCount, 0);
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
