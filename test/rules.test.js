'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { server, buildOutcome, buildMultiOutcome, drawSpies } = require('../server.js');

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

/* ------------------------- 多内鬼模式（2~5 名内鬼，每人 2 票） ------------------------- */

test('多内鬼抽签：两队数量相同，各 2~5 名、不重复、不越界', () => {
  for (let i = 0; i < 300; i += 1) {
    const spies = drawSpies('multi');
    assert.ok(Array.isArray(spies.A) && Array.isArray(spies.B), '多内鬼模式必须返回数组');
    assert.equal(spies.A.length, spies.B.length, '两队内鬼数量必须相同');
    assert.ok(spies.A.length >= 2 && spies.A.length <= 5, `数量越界：${spies.A.length}`);
    assert.ok(spies.A.every((s) => s >= 1 && s <= 5), `A 队座位越界：${spies.A}`);
    assert.ok(spies.B.every((s) => s >= 6 && s <= 10), `B 队座位越界：${spies.B}`);
    assert.equal(new Set(spies.A).size, spies.A.length, '同队内鬼不能重复');
    assert.equal(new Set(spies.B).size, spies.B.length, '同队内鬼不能重复');
  }
});

test('多内鬼计票：本队平民 2 票 + 对面内鬼 2 票都计入，一队共 10 票', () => {
  const o = buildMultiOutcome({
    team: 'A',
    spies: [2, 4],
    votes: {
      1: [2, 5],
      3: [2, 4],
      5: [4, 2], // A 队 3 个平民，每人 2 票
      7: [2, 4],
      9: [2, 4], // B 队 2 个内鬼猜过来的票
    },
  });
  assert.equal(o.countedVotes, 10, '每队 10 票');
  assert.equal(o.counts[2], 5);
  assert.equal(o.counts[4], 4);
  assert.equal(o.counts[5], 1);
  assert.equal(o.topCount, 5);
  assert.deepEqual(o.leaders, [2]);
  assert.deepEqual(o.topSpies, [2], '最高票正好是内鬼');
});

test('多内鬼计票：内鬼之间的票也算数，平票并列全部标出', () => {
  const o = buildMultiOutcome({
    team: 'B',
    spies: [6, 8],
    votes: { 6: [8, 7], 7: [8, 6], 8: [6, 7], 9: [6, 8], 10: [6, 8] },
  });
  assert.equal(o.counts[6], 4);
  assert.equal(o.counts[8], 4);
  assert.equal(o.counts[7], 2);
  assert.equal(o.topCount, 4);
  assert.deepEqual(o.leaders, [6, 8]);
  assert.deepEqual(o.topSpies, [6, 8], '并列时两名内鬼都算最高票');
});

test('多内鬼计票：最高票是平民时没有“票数最高的内鬼”', () => {
  const o = buildMultiOutcome({
    team: 'A',
    spies: [2, 4],
    votes: { 1: [3, 5], 3: [1, 5], 5: [1, 3], 7: [3, 5], 9: [3, 5] },
  });
  assert.deepEqual(o.leaders, [3, 5]);
  assert.deepEqual(o.topSpies, [], '内鬼没拿到最高票');
});

test('未知模式回落到经典模式', async () => {
  const host = await call('/api/rooms', { name: '模式测试', seat: 1, mode: 'weird' });
  assert.equal(host.status, 200);
  assert.equal(host.data.mode, 'classic');
});

test('多内鬼完整一局：每人 2 票、内鬼猜对面、结算公开全部内鬼与票数', async () => {
  const players = [];
  const host = await call('/api/rooms', { name: 'P1', seat: 1, mode: 'multi' });
  assert.equal(host.status, 200);
  assert.equal(host.data.mode, 'multi');
  players.push({ token: host.data.token, seat: host.data.seat });
  const code = host.data.code;

  const preview = await call(`/api/rooms?code=${code}`);
  assert.equal(preview.data.mode, 'multi', '查房接口要带上模式');

  for (let seat = 2; seat <= 10; seat += 1) {
    const res = await call('/api/join', { code, name: `P${seat}`, seat });
    assert.equal(res.status, 200, `座位 ${seat} 加入失败`);
    players.push({ token: res.data.token, seat: res.data.seat });
  }

  const started = await call('/api/action', { token: players[0].token, action: 'start_round' });
  assert.equal(started.status, 200);
  assert.equal(started.data.state.mode, 'multi');

  const spiesA = [];
  const spiesB = [];
  for (const player of players) {
    const state = (await call(`/api/state?token=${player.token}`)).data.state;
    assert.equal(state.mode, 'multi');
    assert.equal(state.spies, null, '看身份阶段绝不能下发全员身份');
    assert.equal(state.outcome, null, '还没结算就不该有票数');
    assert.ok(state.myRole === 'spy' || state.myRole === 'villager');
    assert.equal(state.isSpyBallot, state.myRole === 'spy', '内鬼用“猜对面”那套票');
    assert.equal(state.myVoteTarget, null, '经典模式的一票字段在多内鬼模式下为空');
    assert.equal(state.myVoteTargets, null);
    for (const seat of state.seats) {
      assert.equal(seat.role, undefined, '座位列表里不能带角色字段');
    }
    if (state.myRole === 'spy') (player.seat <= 5 ? spiesA : spiesB).push(player.seat);
  }
  assert.equal(spiesA.length, spiesB.length, '两队内鬼数量必须相同');
  assert.ok(spiesA.length >= 2 && spiesA.length <= 5, `实际 ${spiesA.length} 名`);

  const beforeVoting = (await call(`/api/state?token=${players[0].token}`)).data.state;
  assert.equal(beforeVoting.voteTargets.length, 0, '还没进投票阶段就没有候选');

  for (const player of players) {
    await call('/api/action', { token: player.token, action: 'confirm_identity' });
  }
  const voting = await call('/api/action', { token: players[0].token, action: 'start_voting' });
  assert.equal(voting.data.state.phase, 'voting');

  // 两票的校验：少选、重复都拒绝
  const onlyOne = await call('/api/action', { token: players[0].token, action: 'vote', targets: [2] });
  assert.equal(onlyOne.status, 400, '必须一次选满 2 票');
  assert.match(onlyOne.data.error, /2 个人/);
  const duplicated = await call('/api/action', { token: players[0].token, action: 'vote', targets: [2, 2] });
  assert.equal(duplicated.status, 400, '两票不能投给同一个人');
  assert.match(duplicated.data.error, /同一个人/);

  const aVillager = players.find((p) => p.seat <= 5 && !spiesA.includes(p.seat));
  if (aVillager) {
    const mate = [1, 2, 3, 4, 5].find((s) => s !== aVillager.seat);
    const cross = await call('/api/action', {
      token: aVillager.token,
      action: 'vote',
      targets: [mate, 7],
    });
    assert.equal(cross.status, 400, '平民不能投别的队伍');
    assert.match(cross.data.error, /本队/);
    const self = await call('/api/action', {
      token: aVillager.token,
      action: 'vote',
      targets: [aVillager.seat, mate],
    });
    assert.equal(self.status, 400, '不能投给自己');
  }

  const aSpy = players.find((p) => spiesA.includes(p.seat));
  const spyView = (await call(`/api/state?token=${aSpy.token}`)).data.state;
  assert.equal(spyView.isSpyBallot, true);
  assert.equal(spyView.voteTargets.length, 5, '内鬼的候选是对方队伍 5 人');
  assert.ok(
    spyView.voteTargets.every((t) => (t.seat <= 5 ? 'A' : 'B') !== spyView.team),
    '内鬼只会看到对面队伍的候选人',
  );
  const ownTeamSeats = (spyView.team === 'A' ? [1, 2, 3, 4, 5] : [6, 7, 8, 9, 10])
    .filter((s) => s !== aSpy.seat)
    .slice(0, 2);
  const spyOwnTeam = await call('/api/action', {
    token: aSpy.token,
    action: 'vote',
    targets: ownTeamSeats,
  });
  assert.equal(spyOwnTeam.status, 400, '内鬼不能投本队的人');
  assert.match(spyOwnTeam.data.error, /对面/);

  // 全员各投 2 票：内鬼投对面、平民投本队，各队循环错开，投完每队恰好 10 票
  const targetsFor = (seat) => {
    const isSpy = spiesA.includes(seat) || spiesB.includes(seat);
    const ownBase = seat <= 5 ? 1 : 6;
    const base = isSpy ? (ownBase === 1 ? 6 : 1) : ownBase;
    const i = seat - ownBase;
    return [base + ((i + 1) % 5), base + ((i + 2) % 5)];
  };
  for (const player of players) {
    const res = await call('/api/action', {
      token: player.token,
      action: 'vote',
      targets: targetsFor(player.seat),
    });
    assert.equal(res.status, 200, `座位 ${player.seat} 投票失败：${res.data.error || ''}`);
  }

  const votedView = (await call(`/api/state?token=${players[3].token}`)).data.state;
  assert.deepEqual(votedView.myVoteTargets, targetsFor(players[3].seat).slice().sort((a, b) => a - b));

  const state = (await call(`/api/state?token=${players[0].token}`)).data.state;
  assert.equal(state.phase, 'result', '全员投完后应自动结算');
  assert.equal(state.outcome.mode, 'multi');
  assert.deepEqual(state.spies, { A: spiesA, B: spiesB }, '结算后才公开全部内鬼');
  assert.deepEqual(state.outcome.A.spies, spiesA);
  assert.deepEqual(state.outcome.B.spies, spiesB);
  assert.equal(state.outcome.A.countedVotes, 10, '每队 10 票：本队平民 2 票×人数 + 对面内鬼 2 票×人数');
  assert.equal(state.outcome.B.countedVotes, 10);
  assert.equal(state.outcome.ballots.length, 20, '10 个人每人 2 条票');
  assert.equal(state.outcome.ballots.filter((b) => b.countsIn === 'A').length, 10);
  assert.equal(state.outcome.ballots.filter((b) => b.countsIn === 'B').length, 10);
  assert.ok(state.outcome.ballots.every((b) => b.crossTeam === b.bySpy), '平民票在本队，内鬼票跨队');
  for (const player of players) {
    const mine = state.outcome.ballots.filter((b) => b.voter === player.seat);
    assert.equal(mine.length, 2, `座位 ${player.seat} 应有 2 条票`);
    assert.notEqual(mine[0].target, mine[1].target, '两票不能是同一个人');
    assert.deepEqual(
      mine.map((b) => b.target).sort((a, b) => a - b),
      targetsFor(player.seat).slice().sort((a, b) => a - b),
    );
  }
  assert.ok(state.outcome.A.topSpies.every((s) => spiesA.includes(s)), '票数最高的内鬼来自本队内鬼名单');
  assert.ok(state.outcome.B.topSpies.every((s) => spiesB.includes(s)));
  for (const team of ['A', 'B']) {
    const o = state.outcome[team];
    const max = Math.max(...Object.values(o.counts));
    assert.equal(o.topCount, max, `${team} 队最高票数应等于票数最大值`);
    assert.deepEqual(
      o.leaders,
      Object.keys(o.counts)
        .map(Number)
        .filter((s) => o.counts[s] === max),
    );
  }

  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].mode, 'multi');
  assert.deepEqual(
    state.history[0].A.spies.map((x) => x.seat),
    spiesA,
    '历史战绩里存的是当时的内鬼名单',
  );
  assert.equal(state.history[0].A.countedVotes, 10);

  const next = await call('/api/action', { token: players[0].token, action: 'start_round' });
  assert.equal(next.data.state.phase, 'reveal');
  assert.equal(next.data.state.round, 2);
  assert.equal(next.data.state.spies, null);
  assert.equal(next.data.state.myVoteTargets, null);
  assert.equal(next.data.state.history.length, 1, '历史战绩跨轮保留');
});

/* ------------------------- 经典模式：比赛结果 + 红包清单（单倍） ------------------------- */

async function setupClassicRound() {
  const players = [];
  const host = await call('/api/rooms', { name: 'P1', seat: 1 });
  players.push({ token: host.data.token, seat: host.data.seat });
  const code = host.data.code;
  for (let seat = 2; seat <= 10; seat += 1) {
    const res = await call('/api/join', { code, name: `P${seat}`, seat });
    assert.equal(res.status, 200, `座位 ${seat} 加入失败`);
    players.push({ token: res.data.token, seat: res.data.seat });
  }
  await call('/api/action', { token: players[0].token, action: 'start_round' });

  const spies = { A: null, B: null };
  for (const player of players) {
    const state = (await call(`/api/state?token=${player.token}`)).data.state;
    if (state.myRole === 'spy') spies[state.team] = player.seat;
  }
  assert.ok(spies.A >= 1 && spies.A <= 5, `A 队内鬼异常：${spies.A}`);
  assert.ok(spies.B >= 6 && spies.B <= 10, `B 队内鬼异常：${spies.B}`);

  for (const player of players) {
    await call('/api/action', { token: player.token, action: 'confirm_identity' });
  }
  await call('/api/action', { token: players[0].token, action: 'start_voting' });
  return { players, spies };
}

test('红包清单：投票阶段录赢家，两队内鬼都被投出时都发 5 个红包', async () => {
  const { players, spies } = await setupClassicRound();

  const setWinner = await call('/api/action', { token: players[0].token, action: 'set_match_winner', winner: 'A' });
  assert.equal(setWinner.status, 200, '投票阶段可以录比赛结果');
  assert.equal(setWinner.data.state.matchWinner, 'A');
  assert.equal(setWinner.data.state.settlement, null, '投票还没结束就没有清单');

  const forbidden = await call('/api/action', {
    token: players[3].token,
    action: 'set_match_winner',
    winner: 'A',
  });
  assert.equal(forbidden.status, 403, '只有房主能录比赛结果');
  const bad = await call('/api/action', { token: players[0].token, action: 'set_match_winner', winner: 'C' });
  assert.equal(bad.status, 400, '比赛结果只能是 A / B');

  // 全员投票：平民投本队内鬼，内鬼猜对面内鬼
  for (const player of players) {
    const myTeam = player.seat <= 5 ? 'A' : 'B';
    const amSpy = player.seat === spies.A || player.seat === spies.B;
    const target = amSpy ? (myTeam === 'A' ? spies.B : spies.A) : spies[myTeam];
    const res = await call('/api/action', { token: player.token, action: 'vote', target });
    assert.equal(res.status, 200, `座位 ${player.seat} 投票失败`);
  }

  const state = (await call(`/api/state?token=${players[0].token}`)).data.state;
  assert.equal(state.phase, 'result');
  assert.equal(state.outcome.A.reason, 'caught');
  assert.equal(state.outcome.B.reason, 'caught');
  assert.ok(state.settlement, '结算后应生成红包清单');
  assert.equal(state.settlement.winner, 'A');
  assert.equal(state.settlement.entries.length, 2);

  const payA = state.settlement.entries.find((e) => e.team === 'A');
  assert.equal(payA.action, 'pay');
  assert.equal(payA.teamWon, true);
  assert.equal(payA.caught, true);
  assert.equal(payA.packets, 5);
  assert.equal(payA.amount, 5);
  assert.equal(payA.receivers.length, 5, '己方 4 个平民 + 对方内鬼 = 5 人领');
  assert.equal(payA.receivers.filter((r) => r.seat <= 5).length, 4, '己方 4 个平民领');
  assert.ok(payA.receivers.some((r) => r.seat === spies.B), '对方内鬼也要领 1 元');
  assert.ok(!payA.receivers.some((r) => r.seat === spies.A), '内鬼自己不领');

  const payB = state.settlement.entries.find((e) => e.team === 'B');
  assert.equal(payB.action, 'pay', 'B 队输了但内鬼被投出，仍然要发');
  assert.equal(payB.teamWon, false);
  assert.equal(payB.caught, true);
  assert.equal(payB.receivers.length, 5);

  assert.equal(state.history[0].matchWinner, 'A', '历史战绩记录比赛结果');
  assert.ok(state.history[0].settlement, '历史战绩记录红包清单');

  // 改赢家 → 清单和历史战绩一起重算
  const changed = await call('/api/action', { token: players[0].token, action: 'set_match_winner', winner: 'B' });
  const s2 = changed.data.state;
  assert.equal(s2.settlement.winner, 'B');
  assert.equal(s2.settlement.entries.find((e) => e.team === 'A').teamWon, false);
  assert.equal(s2.settlement.entries.find((e) => e.team === 'A').action, 'pay', '内鬼被投出，无论谁赢都要发');
  assert.equal(s2.history[0].settlement.winner, 'B', '历史战绩里的清单同步更新');

  // 撤回 → 比赛结果和清单一起清空，之后可以重新录
  const cleared = await call('/api/action', { token: players[0].token, action: 'set_match_winner', winner: null });
  assert.equal(cleared.status, 200);
  const s3 = cleared.data.state;
  assert.equal(s3.matchWinner, null, '撤回后比赛结果清空');
  assert.equal(s3.settlement, null, '撤回后红包清单清空');
  assert.equal(s3.history[0].matchWinner, null, '历史战绩里的比赛结果同步清空');
  assert.equal(s3.history[0].settlement, null, '历史战绩里的清单同步清空');
  const again = await call('/api/action', { token: players[0].token, action: 'set_match_winner', winner: 'B' });
  assert.equal(again.data.state.settlement.winner, 'B', '撤回后还能重新录');
});

test('红包清单：输了且没被投出的内鬼免罚，漏投的平民每人给他 1 元', async () => {
  const { players, spies } = await setupClassicRound();
  const vA = [1, 2, 3, 4, 5].find((s) => s !== spies.A);
  const vB = [6, 7, 8, 9, 10].find((s) => s !== spies.B);
  const fallbackA = [1, 2, 3, 4, 5].find((s) => s !== spies.A && s !== vA);
  const fallbackB = [6, 7, 8, 9, 10].find((s) => s !== spies.B && s !== vB);

  // 两队平民都投自家平民，两队内鬼都猜对面，最后两队都是「投错人」
  for (const player of players) {
    const myTeam = player.seat <= 5 ? 'A' : 'B';
    const amSpy = player.seat === spies.A || player.seat === spies.B;
    const villagerTarget =
      myTeam === 'A' ? (player.seat === vA ? fallbackA : vA) : player.seat === vB ? fallbackB : vB;
    const target = amSpy ? (myTeam === 'A' ? vB : vA) : villagerTarget;
    const res = await call('/api/action', { token: player.token, action: 'vote', target });
    assert.equal(res.status, 200, `座位 ${player.seat} 投票失败`);
  }

  const before = (await call(`/api/state?token=${players[0].token}`)).data.state;
  assert.equal(before.phase, 'result');
  assert.equal(before.matchWinner, null);
  assert.equal(before.settlement, null, '没录比赛结果就没有清单');
  assert.equal(before.outcome.A.reason, 'wrong_person');
  assert.equal(before.outcome.B.reason, 'wrong_person');

  const setWinner = await call('/api/action', { token: players[0].token, action: 'set_match_winner', winner: 'A' });
  assert.equal(setWinner.status, 200);
  const settle = setWinner.data.state.settlement;
  assert.ok(settle, '录完比赛结果立刻生成清单');

  const entryA = settle.entries.find((e) => e.team === 'A');
  assert.equal(entryA.action, 'pay');
  assert.equal(entryA.teamWon, true);
  assert.equal(entryA.caught, false, 'A 队赢了，但内鬼没被投出');
  assert.equal(entryA.receivers.filter((r) => r.seat <= 5).length, 4);

  const entryB = settle.entries.find((e) => e.team === 'B');
  assert.equal(entryB.action, 'collect', 'B 队输了且内鬼没被投出 → 免罚');
  assert.equal(entryB.teamWon, false);
  assert.equal(entryB.caught, false);
  assert.equal(entryB.amount, 4, 'B 队 4 个平民都没投中内鬼，每人给 1 元');
  assert.deepEqual(
    entryB.payers.map((p) => p.seat).sort((a, b) => a - b),
    [6, 7, 8, 9, 10].filter((s) => s !== spies.B),
    '每个漏投的平民都要给内鬼发 1 元',
  );
});

test('多内鬼红包清单：赢队内鬼每人发 5 个包（总额 6−人数），平民不发', async () => {
  const players = [];
  const host = await call('/api/rooms', { name: 'P1', seat: 1, mode: 'multi' });
  players.push({ token: host.data.token, seat: host.data.seat });
  const code = host.data.code;
  for (let seat = 2; seat <= 10; seat += 1) {
    const res = await call('/api/join', { code, name: `P${seat}`, seat });
    players.push({ token: res.data.token, seat: res.data.seat });
  }
  await call('/api/action', { token: players[0].token, action: 'start_round' });

  const spiesA = [];
  const spiesB = [];
  for (const player of players) {
    const state = (await call(`/api/state?token=${player.token}`)).data.state;
    if (state.myRole === 'spy') (player.seat <= 5 ? spiesA : spiesB).push(player.seat);
  }
  const k = spiesA.length;
  assert.equal(spiesB.length, k, '两队内鬼数量相同');
  assert.ok(k >= 2 && k <= 5);

  for (const player of players) {
    await call('/api/action', { token: player.token, action: 'confirm_identity' });
  }
  await call('/api/action', { token: players[0].token, action: 'start_voting' });

  const targetsFor = (seat) => {
    const isSpy = spiesA.includes(seat) || spiesB.includes(seat);
    const ownBase = seat <= 5 ? 1 : 6;
    const base = isSpy ? (ownBase === 1 ? 6 : 1) : ownBase;
    const i = seat - ownBase;
    return [base + ((i + 1) % 5), base + ((i + 2) % 5)];
  };
  for (const player of players) {
    const res = await call('/api/action', {
      token: player.token,
      action: 'vote',
      targets: targetsFor(player.seat),
    });
    assert.equal(res.status, 200, `座位 ${player.seat} 投票失败`);
  }

  const before = (await call(`/api/state?token=${players[0].token}`)).data.state;
  assert.equal(before.phase, 'result');
  assert.equal(before.settlement, null, '没录比赛结果就没有清单');

  const res = await call('/api/action', { token: players[0].token, action: 'set_match_winner', winner: 'A' });
  assert.equal(res.status, 200, '多内鬼模式也能录比赛结果');
  const settle = res.data.state.settlement;
  assert.ok(settle, '录完比赛结果立刻生成清单');
  assert.equal(settle.mode, 'multi');
  assert.equal(settle.spyCount, k);
  assert.equal(settle.perSpy, 6 - k);
  assert.equal(settle.entries.length, 2 * k, '每个内鬼一条记录');

  for (const entry of settle.entries) {
    const topSpies = before.outcome[entry.team].topSpies;
    assert.equal(entry.caught, topSpies.includes(entry.spy.seat), '被投出=本队最高票里的内鬼');
    assert.equal(entry.teamWon, entry.team === 'A');
    assert.equal(entry.action, entry.teamWon || entry.caught ? 'pay' : 'free');
    if (entry.action === 'pay') {
      assert.equal(entry.packets, 5);
      assert.equal(entry.amount, 6 - k);
      assert.equal(entry.receivers.length, 5, '己方平民 + 对方内鬼 = 5 人领包');
    }
  }

  // 赢队（A）内鬼全部要发；领包人 = A 队平民 + B 队全部内鬼
  const aEntries = settle.entries.filter((e) => e.team === 'A');
  assert.equal(aEntries.length, k);
  assert.ok(aEntries.every((e) => e.action === 'pay'), 'A 队赢了，A 队内鬼都要发');
  assert.deepEqual(
    aEntries[0].receivers.filter((r) => r.seat <= 5).map((r) => r.seat).sort((a, b) => a - b),
    [1, 2, 3, 4, 5].filter((s) => !spiesA.includes(s)),
    '本队平民领包',
  );
  assert.deepEqual(
    aEntries[0].receivers.filter((r) => r.seat > 5).map((r) => r.seat).sort((a, b) => a - b),
    spiesB.slice().sort((a, b) => a - b),
    '对方内鬼领包',
  );

  // 平民不参与发红包：只有 pay / free 两种
  assert.ok(settle.entries.every((e) => e.action === 'pay' || e.action === 'free'));

  assert.equal(res.data.state.history[0].matchWinner, 'A');
  assert.ok(res.data.state.history[0].settlement, '历史战绩记录多内鬼模式的清单');
});
