'use strict';

// 线上自检脚本：对一个已经部署好的服务，真的开一局 10 人局跑完整流程。
//
// 用法：
//   node test/verify-deployed.js https://你的网址.onrender.com
//   BASE=https://你的网址.onrender.com node test/verify-deployed.js
//
// 跑完会在那个服务上留下一间空的测试房间（玩家名叫 验收1~验收10），6 小时后自动清理。

const BASE = (process.argv[2] || process.env.BASE || 'http://localhost:3000').replace(/\/+$/, '');

const TEAM_SEATS = { A: [1, 2, 3, 4, 5], B: [6, 7, 8, 9, 10] };
const teamOf = (seat) => (seat <= 5 ? 'A' : 'B');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  [OK] ${label}`);
  } else {
    failed += 1;
    console.log(`  [!!] ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function call(path, body) {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, data };
}

const stateOf = async (token) => (await call(`/api/state?token=${token}`)).data.state;
const action = (token, name, extra = {}) => call('/api/action', { token, action: name, ...extra });

async function main() {
  console.log(`\n正在验证: ${BASE}\n`);

  console.log('[1] 服务存活');
  const health = await call('/healthz');
  check('健康检查返回 ok', health.status === 200 && health.data.ok === true, JSON.stringify(health.data));
  if (health.status !== 200) {
    console.log('\n服务没起来，后面的检查跳过。');
    process.exit(1);
  }

  console.log('\n[2] 网页能打开');
  const home = await fetch(BASE + '/').then((r) => r.text()).catch(() => '');
  check('首页返回完整的 HTML', home.includes('id="app"') && home.includes('/app.js'), `收到 ${home.length} 字节`);
  const appJs = await fetch(BASE + '/app.js').then((r) => r.status).catch(() => 0);
  check('前端脚本可以加载', appJs === 200, `HTTP ${appJs}`);

  console.log('\n[3] 两个人可以各自当房主');
  const roomA = await call('/api/rooms', { name: '验收1', seat: 1 });
  const roomB = await call('/api/rooms', { name: '另一个房主', seat: 1 });
  check('第一间房创建成功', roomA.status === 200 && /^\d{4}$/.test(roomA.data.code || ''), JSON.stringify(roomA.data));
  check('第二间房创建成功', roomB.status === 200 && /^\d{4}$/.test(roomB.data.code || ''), JSON.stringify(roomB.data));
  check('两间房房间码不同', roomA.data.code !== roomB.data.code);

  const code = roomA.data.code;
  const tokens = [roomA.data.token];
  const names = ['验收1', '验收2', '验收3', '验收4', '验收5', '验收6', '验收7', '验收8', '验收9', '验收10'];

  console.log('\n[4] 10 个人占座');
  let joined = 1;
  for (let seat = 2; seat <= 10; seat += 1) {
    const res = await call('/api/join', { code, name: names[seat - 1], seat });
    if (res.status !== 200) {
      check(`${seat} 号座位加入`, false, JSON.stringify(res.data));
      break;
    }
    tokens.push(res.data.token);
    joined += 1;
  }
  check('10 个座位全部坐下', joined === 10, `实际 ${joined} 人`);
  const occupied = await call(`/api/rooms?code=${code}`);
  check('房间显示 10 人满座', (occupied.data.seats || []).filter((s) => s.occupied).length === 10);

  console.log('\n[5] 开局前的身份是保密的');
  const lobby = await stateOf(tokens[0]);
  check('大厅阶段没有自己的身份', lobby.myRole === null);
  check('大厅阶段没有全员身份', lobby.spies === null);

  const forbidden = await call('/api/action', { token: tokens[3], action: 'start_round' });
  check('非房主不能开局', forbidden.status === 403);

  const started = await action(tokens[0], 'start_round');
  check('房主开局成功', started.status === 200 && started.data.state.phase === 'reveal');

  console.log('\n[6] 每队各一名内鬼，且只有本人拿得到自己的身份');
  const spies = { A: null, B: null };
  let spyCount = 0;
  let leaked = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const s = await stateOf(tokens[i]);
    if (!s) continue;
    if (s.spies !== null || s.outcome !== null) leaked = true;
    if (s.seats.some((x) => x.role !== undefined)) leaked = true;
    if (s.myRole === 'spy') {
      spyCount += 1;
      spies[s.team] = s.seat;
    }
  }
  check('全场正好两名内鬼', spyCount === 2, `实际 ${spyCount}`);
  check('A 队内鬼在 1-5 号', spies.A >= 1 && spies.A <= 5, `A=${spies.A}`);
  check('B 队内鬼在 6-10 号', spies.B >= 6 && spies.B <= 10, `B=${spies.B}`);
  check('看身份阶段没有泄露别人的角色或票数', !leaked);

  console.log('\n[7] 投票规则');
  for (const token of tokens) await action(token, 'confirm_identity');
  const voting = await action(tokens[0], 'start_voting');
  check('进入投票阶段', voting.status === 200 && voting.data.state.phase === 'voting');

  const villagerSeats = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((s) => s !== spies.A && s !== spies.B);
  const villagerSeat = villagerSeats[0];
  const villagerToken = tokens[villagerSeat - 1];

  const cross = await action(villagerToken, 'vote', { target: teamOf(villagerSeat) === 'A' ? 7 : 1 });
  check('不能投别的队伍', cross.status === 400, cross.data.error);
  const selfVote = await action(villagerToken, 'vote', { target: villagerSeat });
  check('不能投给自己', selfVote.status === 400, selfVote.data.error);

  // 内鬼：不能投本队，改成在对面 5 人里猜
  const spyTokenA = tokens[spies.A - 1];
  const spyView = await stateOf(spyTokenA);
  check('内鬼的投票标记为“猜对面”', spyView.isSpyBallot === true);
  check(
    '内鬼的候选正好是对方队伍的 5 个人',
    spyView.voteTargets.length === 5 && spyView.voteTargets.every((t) => t.team === 'B'),
    `候选 ${spyView.voteTargets.length} 个`,
  );
  check('内鬼依然拿不到全员身份', spyView.spies === null);
  const ownTeamMate = TEAM_SEATS.A.find((s) => s !== spies.A);
  const spyOwnTeam = await action(spyTokenA, 'vote', { target: ownTeamMate });
  check('内鬼不能投本队的人', spyOwnTeam.status === 400, spyOwnTeam.data.error);
  const spyGuess = await action(spyTokenA, 'vote', { target: spies.B });
  check(
    '内鬼可以在对面队伍里猜一个',
    spyGuess.status === 200 && spyGuess.data.state.myVoteTarget === spies.B,
    JSON.stringify(spyGuess.data.error || ''),
  );

  // 另一名内鬼故意猜错，用来验证结算页“猜错了”的展示
  const wrongGuessSeat = TEAM_SEATS.A.find((s) => s !== spies.A);
  const spyGuessB = await action(tokens[spies.B - 1], 'vote', { target: wrongGuessSeat });
  check('另一名内鬼也能猜对面', spyGuessB.status === 200, JSON.stringify(spyGuessB.data.error || ''));

  const nonSpy = {
    A: TEAM_SEATS.A.filter((s) => s !== spies.A),
    B: TEAM_SEATS.B.filter((s) => s !== spies.B),
  };
  for (let seat = 1; seat <= 10; seat += 1) {
    if (seat === spies.A || seat === spies.B) continue;
    const team = teamOf(seat);
    const spy = spies[team];
    const pool = nonSpy[team];
    let target;
    if (team === 'A') {
      target = spy; // A 队平民全投内鬼
    } else if (seat === pool[0]) {
      target = pool[1];
    } else if (seat === pool[1] || seat === pool[2]) {
      target = pool[0];
    } else {
      target = pool[1];
    }
    await action(tokens[seat - 1], 'vote', { target });
  }

  console.log('\n[8] 结算');
  const final = await stateOf(tokens[0]);
  check('全部投完后自动结算', final.phase === 'result', final.phase);
  check(
    '结算后才公开内鬼',
    final.spies !== null && final.spies.A === spies.A && final.spies.B === spies.B,
  );
  check('A 队抓到内鬼', final.outcome.A.reason === 'caught', final.outcome.A.reason);
  check(
    '每队 5 票（本队平民 4 票 + 对面内鬼 1 票）',
    final.outcome.A.countedVotes === 5 && final.outcome.B.countedVotes === 5,
    `A=${final.outcome.A.countedVotes} B=${final.outcome.B.countedVotes}`,
  );
  check(
    'A 队内鬼拿到本队平民的全部 4 票',
    final.outcome.A.counts[spies.A] === 4,
    `得票 ${final.outcome.A.counts[spies.A]}`,
  );
  check(
    'B 队内鬼拿到本队 0 票 + A 队内鬼猜中的 1 票',
    final.outcome.B.counts[spies.B] === 1,
    `得票 ${final.outcome.B.counts[spies.B]}`,
  );
  check(
    'B 队内鬼猜错的那一票落在平民头上',
    final.outcome.A.counts[wrongGuessSeat] === 1,
    `${wrongGuessSeat} 号得票 ${final.outcome.A.counts[wrongGuessSeat]}`,
  );
  check('B 队平票且内鬼胜出', final.outcome.B.reason === 'tie', final.outcome.B.reason);

  check('每个人那一票都有记录', final.outcome.ballots.length === 10, `${final.outcome.ballots.length} 条`);
  const spyBallotA = final.outcome.ballots.find((b) => b.voter === spies.A);
  const spyBallotB = final.outcome.ballots.find((b) => b.voter === spies.B);
  check('内鬼猜中对面内鬼', spyBallotA.target === spies.B, `猜到 ${spyBallotA.target} 号`);
  check('内鬼猜错了也如实记录', spyBallotB.target === wrongGuessSeat && spyBallotB.bySpy === true);
  check(
    '内鬼那一票算进对面队伍的票数',
    spyBallotA.countsIn === 'B' && spyBallotB.countsIn === 'A',
    `A 内鬼票->${spyBallotA.countsIn} 队，B 内鬼票->${spyBallotB.countsIn} 队`,
  );
  check(
    '两队各收到 5 张票',
    final.outcome.ballots.filter((b) => b.countsIn === 'A').length === 5 &&
      final.outcome.ballots.filter((b) => b.countsIn === 'B').length === 5,
  );
  check(
    '写入历史战绩',
    final.history.length === 1 && final.history[0].A.spy.seat === spies.A && final.history[0].B.spy.seat === spies.B,
    JSON.stringify(final.history.map((h) => h.round)),
  );

  const late = await action(tokens[1], 'vote', { target: spies.A });
  check('结算后不能再投票', late.status === 409);

  console.log('\n[9] 开新一轮');
  const second = await action(tokens[0], 'start_round');
  check('进入第 2 轮', second.status === 200 && second.data.state.round === 2, `round=${second.data.state.round}`);
  check('票数和结果已清空', second.data.state.myVoteTarget === null && second.data.state.outcome === null);
  check('新一轮身份重新保密', second.data.state.spies === null);
  check('新一轮里历史战绩依然可查', second.data.state.history.length === 1);

  console.log('\n[10] 收尾：把测试占用的座位退掉');
  let freed = 0;
  for (const token of [...tokens, roomB.data.token]) {
    const res = await action(token, 'leave');
    if (res.status === 200) freed += 1;
  }
  check('测试玩家全部退出', freed === 11, `退出 ${freed}/11`);

  console.log(`\n${'-'.repeat(46)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log(failed === 0 ? '线上环境和本地行为一致，可以放心发给朋友。' : '有项目没通过，把上面的输出发我。');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(`\n[!!] 执行中断：${err.message}`);
  console.log('如果是 fetch failed / ECONNREFUSED，说明这个网址现在连不上（服务在休眠或已停止）。');
  process.exitCode = 1;
});
