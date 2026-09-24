'use strict';

/* 内鬼模式 · 前端
 * 只有自己的身份会从服务端下发，页面里也不会缓存别人的身份。
 * 轮询间隔 1.2 秒；标签页在后台时降到 3 秒。 */

const STORAGE_KEY = 'lol-spy-session-v1';
const POLL_MS = 1200;
const IDLE_POLL_MS = 3000;

const ui = {
  tab: 'create',
  createName: '',
  createSeat: 1,
  joinCode: '',
  joinName: '',
  joinSeat: null,
  joinPreview: null,
  joinError: '',
  homeError: '',
  revealed: false,
  detailOpen: false,
};

let session = null;
let snapshot = null;
let lastSig = '';
let pollTimer = null;
let busy = false;
let toastTimer = null;

/* ----------------------------- 小工具 ----------------------------- */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === 'string' && typeof parsed.code === 'string') return parsed;
  } catch {
    /* 存储被禁用时忽略 */
  }
  return null;
}

function saveSession(next) {
  session = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, kind === 'error' ? 4200 : 2200);
}

async function api(pathname, options = {}) {
  const res = await fetch(pathname, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  return data;
}

async function copyText(text, okMessage) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    toast(okMessage);
  } catch {
    toast(`复制失败，请手动复制：${text}`, 'error');
  }
}

/* ----------------------------- 焦点保持 ----------------------------- */

function captureFocus() {
  const el = document.activeElement;
  if (el && el.tagName === 'INPUT' && el.id) {
    return { id: el.id, start: el.selectionStart, end: el.selectionEnd };
  }
  return null;
}

function restoreFocus(info) {
  if (!info) return;
  const el = document.getElementById(info.id);
  if (!el) return;
  el.focus();
  try {
    el.setSelectionRange(info.start, info.end);
  } catch {
    /* 类型不支持时忽略 */
  }
}

/* ----------------------------- 渲染 ----------------------------- */

function render() {
  const focus = captureFocus();
  let html;
  if (session && !snapshot) html = renderLoading();
  else if (snapshot) html = renderRoom(snapshot);
  else html = renderHome();
  document.getElementById('app').innerHTML = html;
  restoreFocus(focus);
}

function renderLoading() {
  return `
    <header class="hero">
      <div class="badge">内鬼模式</div>
      <h1>正在连接房间…</h1>
    </header>
    <div class="card"><p class="muted"><span class="spinner"></span>正在读取房间状态。</p></div>`;
}

function renderHome() {
  return `
    <header class="hero">
      <div class="badge">5V5 · 双方各一名内鬼</div>
      <h1>内鬼模式</h1>
      <p>开局随机、身份只有自己看得见、赛后队内投票。<br>10 个人各开各的页面，只需要一个房间码。</p>
    </header>
    ${ui.homeError ? `<div class="card"><p style="color:#e0574c;font-size:14px">${esc(ui.homeError)}</p></div>` : ''}
    <div class="card">
      <div class="row" style="margin-bottom:16px">
        <button class="${ui.tab === 'create' ? '' : 'ghost'} grow" data-act="tab" data-tab="create">创建房间</button>
        <button class="${ui.tab === 'join' ? '' : 'ghost'} grow" data-act="tab" data-tab="join">加入房间</button>
      </div>
      ${ui.tab === 'create' ? renderCreateForm() : renderJoinForm()}
    </div>
    <p class="muted foot">
      规则：1–5 号为 A 队，6–10 号为 B 队，每队各随机一名内鬼。游戏结束后队内投票，每人只能投本队其他人；
      内鬼照常投票，但那一票作废。唯一最高票正好是内鬼则平民胜出，平票或投错人则内鬼胜出。
    </p>`;
}

function seatPicker(seats, selected, action) {
  const cells = seats
    .map((seat) => {
      const cls = ['seat-pick'];
      if (seat.occupied) cls.push('taken');
      if (seat.seat === selected) cls.push('selected');
      const label = seat.occupied ? `${seat.seat}号 已占` : `${seat.seat}号`;
      return `<button class="${cls.join(' ')}" data-act="${action}" data-seat="${seat.seat}" ${
        seat.occupied ? 'disabled' : ''
      }>${label}</button>`;
    })
    .join('');
  return `<div class="seat-grid">${cells}</div>`;
}

function emptySeatMap() {
  return Array.from({ length: 10 }, (_, i) => ({ seat: i + 1, occupied: false, name: null }));
}

function renderCreateForm() {
  return `
    <label>你的昵称
      <input id="create-name" maxlength="12" placeholder="例如：老王" value="${esc(ui.createName)}" />
    </label>
    <div class="muted" style="margin-bottom:6px">选一个座位（A 队 1–5，B 队 6–10）</div>
    ${seatPicker(emptySeatMap(), ui.createSeat, 'pick-create-seat')}
    <div style="margin-top:16px">
      <button class="primary" data-act="create" ${ui.createName.trim() ? '' : 'disabled'}>创建房间</button>
    </div>
    <p class="muted" style="margin-top:10px">创建后你会成为房主，负责开始本轮、开始投票和开始新一轮。</p>`;
}

function renderJoinForm() {
  const preview = ui.joinPreview;
  return `
    <label>房间码
      <input id="join-code" inputmode="numeric" autocomplete="off" maxlength="4" placeholder="4 位数字"
        value="${esc(ui.joinCode)}" />
    </label>
    ${
      ui.joinError
        ? `<p style="color:#e0574c;font-size:13px;margin-bottom:14px">${esc(ui.joinError)}</p>`
        : ''
    }
    ${
      preview
        ? `<div class="muted" style="margin-bottom:6px">点一个空座位坐下</div>${seatPicker(
            preview.seats,
            ui.joinSeat,
            'pick-join-seat',
          )}`
        : '<p class="muted">输入 4 位房间码后会自动查询空位。</p>'
    }
    <label style="margin-top:16px">你的昵称
      <input id="join-name" maxlength="12" placeholder="例如：小李" value="${esc(ui.joinName)}" />
    </label>
    <button class="primary" data-act="join" ${preview && ui.joinSeat && ui.joinName.trim() ? '' : 'disabled'}>
      加入房间
    </button>`;
}

function renderTopbar(s) {
  return `
    <div class="topbar">
      <div class="grow">
        <div class="muted">房间码</div>
        <div class="room-code">${esc(s.code)}</div>
      </div>
      <button class="small ghost" data-act="copy-code">复制房间码</button>
      <button class="small ghost" data-act="copy-link">复制邀请链接</button>
    </div>
    <p class="muted" style="margin-top:10px">
      你是 ${s.seat} 号 · ${esc(s.name || '')} · ${s.team} 队${s.isHost ? ' · 房主' : ''}
      ${s.round > 0 ? ` · 第 ${s.round} 轮` : ''}
    </p>`;
}

function seatTags(seat) {
  const tags = [];
  if (seat.confirmed) tags.push('<span class="tag-ok">已确认</span>');
  if (seat.hasVoted) tags.push('<span class="tag-ok">已投票</span>');
  return tags.length ? `<div class="tags">${tags.join('')}</div>` : '';
}

function seatGrid(s, { kickable = false } = {}) {
  return `<div class="seat-grid">${s.seats
    .map((seat) => {
      const cls = ['seat'];
      if (!seat.occupied) cls.push('empty');
      if (seat.isMe) cls.push('me');
      const kick =
        kickable && seat.occupied && !seat.isMe
          ? `<button class="kick" data-act="clear-seat" data-seat="${seat.seat}" title="清空这个座位">×</button>`
          : '';
      return `<div class="${cls.join(' ')}">${kick}
        <div class="num">${seat.seat}号${seat.isHost ? ' · 房主' : ''}</div>
        <div class="nick">${seat.occupied ? esc(seat.name) : '空位'}</div>
        ${seat.occupied ? seatTags(seat) : ''}
      </div>`;
    })
    .join('')}</div>`;
}

function renderLobby(s) {
  const missing = 10 - s.occupiedCount;
  return `
    <div class="phase-title">
      <h2>等待开局</h2>
      <p class="muted">把房间码发给同局的朋友，10 个人到齐后由房主开始。</p>
    </div>
    <div class="card">
      ${seatGrid(s, { kickable: s.isHost })}
      <div class="status-line">已就位 ${s.occupiedCount}/10${missing > 0 ? ` · 还差 ${missing} 人` : ''}</div>
    </div>
    ${
      s.isHost
        ? `<div class="host-panel">
             <div class="label">房主操作</div>
             <button class="primary" data-act="start-round" ${
               s.occupiedCount === 10 ? '' : 'disabled'
             }>开始第 1 轮</button>
             <p class="muted" style="margin-top:10px">点击后每队随机产生一名内鬼，所有人各自查看自己的身份。</p>
           </div>`
        : `<div class="status-line"><span class="spinner"></span>等待房主开始本轮</div>`
    }`;
}

function identityCard(s) {
  const me = s.seats.find((seat) => seat.isMe);
  if (ui.revealed && s.myRole) {
    const isSpy = s.myRole === 'spy';
    return `
      <div class="identity-card ${isSpy ? 'spy' : 'villager'}">
        <div class="role-word ${isSpy ? 'spy' : 'villager'}">${isSpy ? '你是内鬼' : '你是平民'}</div>
        <div class="role-hint">${
          isSpy
            ? '照常参与投票，但你的那一票不计入任何人的票数。别露馅。'
            : '在你们队里找出那个内鬼。'
        }</div>
        <button class="small ghost" data-act="hide-role">隐藏身份</button>
      </div>`;
  }
  return `
    <div class="identity-card hidden-role">
      <div class="muted">${me ? `${esc(me.name)} · ${me.seat} 号 · ${s.team} 队` : ''}</div>
      <button class="primary" style="max-width:280px" data-act="reveal">点击查看我的身份</button>
      <div class="role-hint">确认周围没人在看你的屏幕再点开。</div>
    </div>`;
}

function renderReveal(s) {
  const me = s.seats.find((seat) => seat.isMe);
  const confirmed = Boolean(me && me.confirmed);
  const pending = s.occupiedCount - s.confirmedCount;
  return `
    <div class="phase-title">
      <h2>第 ${s.round} 轮 · 看身份</h2>
      <p class="muted">身份只有你自己的屏幕上能看到，看完请点确认。</p>
    </div>
    ${identityCard(s)}
    <div class="status-line">已确认 ${s.confirmedCount}/${s.occupiedCount}${pending > 0 ? ` · 还有 ${pending} 人没确认` : ''}</div>
    <div style="margin-top:12px">
      <button class="primary" data-act="confirm" ${confirmed ? 'disabled' : ''}>
        ${confirmed ? '已确认身份' : '我记住了，确认身份'}
      </button>
    </div>
    ${
      s.isHost
        ? `<div class="host-panel">
             <div class="label">房主操作</div>
             <button class="primary" data-act="start-voting" ${
               s.confirmedCount >= s.occupiedCount ? '' : 'disabled'
             }>进入投票阶段</button>
             <p class="muted" style="margin-top:10px">${
               s.confirmedCount >= s.occupiedCount
                 ? '所有人都确认了身份，可以开始投票。'
                 : `还有 ${pending} 人没确认身份，等他们看完再开始投票。`
             }</p>
           </div>`
        : `<div class="status-line"><span class="spinner"></span>等待房主开启投票</div>`
    }`;
}

function renderVoting(s) {
  const me = s.seats.find((seat) => seat.isMe);
  const targets = s.voteTargets;
  const voted = s.myVoteTarget != null;
  const waiting = s.occupiedCount - s.votesSubmittedCount;
  const targetName = voted ? s.seats[s.myVoteTarget - 1] : null;

  return `
    <div class="phase-title">
      <h2>第 ${s.round} 轮 · 队内投票</h2>
      <p class="muted">你是 ${s.team} 队，从本队里投出你认为的内鬼。所有人投完才会公布票数。</p>
    </div>
    ${
      voted
        ? `<div class="card">
             <div class="status-line" style="margin-top:0">
               <span class="spinner"></span>你已投给 <b>${esc(targetName ? targetName.name : '')}</b> · 等待其他人（已投 ${s.votesSubmittedCount}/${s.occupiedCount}）
             </div>
             <p class="muted" style="margin-top:10px;text-align:center">投票提交后不能修改。</p>
           </div>`
        : `<div class="card">
             <div class="muted" style="margin-bottom:4px">本队候选人</div>
             <div class="menu">
               ${targets
                 .map(
                   (t) =>
                     `<button data-act="vote" data-seat="${t.seat}">${t.seat} 号 · ${esc(t.name)}</button>`,
                 )
                 .join('')}
             </div>
           </div>`
    }
    <details ${ui.detailOpen ? 'open' : ''} data-act="toggle-detail">
      <summary>查看我的身份</summary>
      <p class="muted" style="margin-top:8px">
        你是 ${s.myRole === 'spy' ? '内鬼' : '平民'}（${s.team} 队 ${s.seat} 号）。${s.myRole === 'spy' ? '你的票会作废，但别让人看出来。' : ''}
      </p>
    </details>
    ${
      s.isHost
        ? `<div class="host-panel">
             <div class="label">房主操作</div>
             <button class="ghost" data-act="end-voting">提前结束投票并结算</button>
             <p class="muted" style="margin-top:10px">${
               waiting > 0 ? `还有 ${waiting} 人没投票，没投的按弃权处理。` : '所有人都投完了。'
             }</p>
           </div>`
        : waiting > 0
          ? `<div class="status-line">还剩 ${waiting} 人没投票</div>`
          : ''
    }`;
}

const VERDICTS = {
  caught: { title: '抓到内鬼 · 平民胜出', cls: 'win-villagers', desc: '唯一最高票正好是内鬼。' },
  tie: { title: '平票 · 内鬼胜出', cls: 'win-spy', desc: '出现并列最高票，按规则内鬼胜出。' },
  wrong_person: { title: '投错人 · 内鬼胜出', cls: 'win-spy', desc: '最高票是一位平民，内鬼溜了。' },
  no_votes: { title: '无人投票 · 内鬼胜出', cls: 'win-spy', desc: '这一队没有任何有效票。' },
};

function renderTeamResult(s, team) {
  const o = s.outcome[team];
  const verdict = VERDICTS[o.reason] || VERDICTS.wrong_person;
  const max = Math.max(o.topCount, 1);
  const rows = Object.keys(o.counts)
    .map(Number)
    .sort((a, b) => o.counts[b] - o.counts[a] || a - b)
    .map((seat) => {
      const meta = s.seats[seat - 1];
      const cls = ['tally-row'];
      if (seat === o.spy) cls.push('is-spy');
      if (o.leaders.includes(seat) && o.topCount > 0) cls.push('is-leader');
      return `<div class="${cls.join(' ')}">
        <div class="tally-name">${seat}号 ${esc(meta ? meta.name : '')}${seat === o.spy ? ' 🔪' : ''}</div>
        <div class="bar"><span style="width:${Math.round((o.counts[seat] / max) * 100)}%"></span></div>
        <div class="count">${o.counts[seat]}</div>
      </div>`;
    })
    .join('');

  const voidVote = o.detail.find((d) => !d.counted);

  return `
    <div class="verdict ${verdict.cls}">
      <div class="verdict-head">
        <div class="verdict-title">${team} 队 · ${verdict.title}</div>
        <div class="muted">有效票 ${o.countedVotes} 张</div>
      </div>
      <div class="spy-line">内鬼是 <span class="spy-name">${
        o.spy
      } 号 ${esc((s.seats[o.spy - 1] || {}).name || '')}</span>${verdict.desc ? ` · ${verdict.desc}` : ''}</div>
      <div class="tally">${rows}</div>
      ${
        voidVote
          ? `<p class="muted" style="margin-top:10px">内鬼那票已作废（${voidVote.voter} 号投给 ${voidVote.target} 号，不计入）。</p>`
          : ''
      }
    </div>`;
}

function renderResult(s) {
  const allVotes = [...s.outcome.A.detail, ...s.outcome.B.detail].sort((a, b) => a.voter - b.voter);
  const detailList = allVotes
    .map((d) => {
      const from = s.seats[d.voter - 1];
      const to = s.seats[d.target - 1];
      return `<li>${d.voter} 号 <b>${esc(from ? from.name : '')}</b> → ${d.target} 号 <b>${esc(
        to ? to.name : '',
      )}</b>${d.counted ? '' : ' <span class="void-tag">（内鬼票，作废）</span>'}</li>`;
    })
    .join('');

  return `
    <div class="phase-title">
      <h2>第 ${s.round} 轮 · 结算</h2>
      <p class="muted">票数只统计有效票，内鬼自己那一票不算。</p>
    </div>
    ${renderTeamResult(s, 'A')}
    ${renderTeamResult(s, 'B')}
    <details>
      <summary>查看投票明细</summary>
      <ul class="detail-list">${detailList || '<li>没有人投票</li>'}</ul>
    </details>
    ${
      s.isHost
        ? `<div class="host-panel">
             <div class="label">房主操作</div>
             <button class="primary" data-act="start-round">开始新一轮（重新随机内鬼）</button>
             <div style="margin-top:10px">
               <button class="ghost small" data-act="back-lobby">回到大厅调整座位</button>
             </div>
           </div>`
        : `<div class="status-line"><span class="spinner"></span>等待房主开始新一轮</div>`
    }`;
}

function renderRoom(s) {
  let body;
  if (s.phase === 'lobby') body = renderLobby(s);
  else if (s.phase === 'reveal') body = renderReveal(s);
  else if (s.phase === 'voting') body = renderVoting(s);
  else body = renderResult(s);

  return `
    ${renderTopbar(s)}
    ${body}
    <div class="row" style="margin-top:20px;justify-content:center">
      <button class="small ghost" data-act="leave">退出房间</button>
    </div>
    <p class="muted foot" style="text-align:center">
      身份和座位都绑在当前浏览器上，刷新页面不会丢。
    </p>`;
}

/* ----------------------------- 数据流 ----------------------------- */

function applySnapshot(state) {
  const prev = snapshot;
  snapshot = state;
  if (!prev || prev.round !== state.round) {
    ui.revealed = false;
    ui.detailOpen = false;
  }
  render();
}

async function refresh() {
  const data = await api(`/api/state?token=${encodeURIComponent(session.token)}`);
  const sig = JSON.stringify(data.state);
  if (sig === lastSig) return;
  lastSig = sig;
  applySnapshot(data.state);
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function startPolling() {
  stopPolling();
  const tick = async () => {
    try {
      await refresh();
    } catch (err) {
      if (err.code === 'SESSION_GONE') {
        stopPolling();
        saveSession(null);
        snapshot = null;
        lastSig = '';
        ui.homeError = '房间的会话已失效（服务重启或房间过期），请重新创建或加入。';
        render();
        return;
      }
      toast(err.message, 'error');
    }
    pollTimer = setTimeout(tick, document.hidden ? IDLE_POLL_MS : POLL_MS);
  };
  tick();
}

function handleError(err) {
  if (err.code === 'SESSION_GONE') {
    stopPolling();
    saveSession(null);
    snapshot = null;
    lastSig = '';
    ui.homeError = '房间的会话已失效（服务重启或房间过期），请重新创建或加入。';
    render();
    return;
  }
  toast(err.message, 'error');
  if (session) refresh().catch(() => {});
}

async function act(action, payload = {}) {
  if (busy || !session) return false;
  busy = true;
  try {
    const data = await api('/api/action', {
      method: 'POST',
      body: { token: session.token, action, ...payload },
    });
    lastSig = JSON.stringify(data.state);
    applySnapshot(data.state);
    return true;
  } catch (err) {
    handleError(err);
    return false;
  } finally {
    busy = false;
  }
}

async function lookupRoom(code) {
  if (code.length !== 4) {
    ui.joinPreview = null;
    ui.joinError = '';
    render();
    return;
  }
  try {
    const data = await api(`/api/rooms?code=${encodeURIComponent(code)}`);
    ui.joinPreview = data;
    ui.joinError = '';
    const taken = data.seats.find((seat) => seat.seat === ui.joinSeat && seat.occupied);
    if (!ui.joinSeat || taken) {
      const free = data.seats.find((seat) => !seat.occupied);
      ui.joinSeat = free ? free.seat : null;
    }
  } catch (err) {
    ui.joinPreview = null;
    ui.joinSeat = null;
    ui.joinError = err.message;
  }
  render();
}

async function createRoom() {
  try {
    const data = await api('/api/rooms', {
      method: 'POST',
      body: { name: ui.createName.trim(), seat: ui.createSeat },
    });
    saveSession({ token: data.token, code: data.code });
    snapshot = null;
    lastSig = '';
    render();
    startPolling();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function joinRoom() {
  try {
    const data = await api('/api/join', {
      method: 'POST',
      body: { code: ui.joinCode, name: ui.joinName.trim(), seat: ui.joinSeat },
    });
    saveSession({ token: data.token, code: data.code });
    snapshot = null;
    lastSig = '';
    render();
    startPolling();
  } catch (err) {
    toast(err.message, 'error');
    lookupRoom(ui.joinCode);
  }
}

/* ----------------------------- 事件 ----------------------------- */

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const action = btn.dataset.act;
  const seat = btn.dataset.seat ? Number(btn.dataset.seat) : null;

  switch (action) {
    case 'tab':
      ui.tab = btn.dataset.tab;
      render();
      break;

    case 'pick-create-seat':
      ui.createSeat = seat;
      render();
      break;

    case 'pick-join-seat':
      ui.joinSeat = seat;
      render();
      break;

    case 'create':
      createRoom();
      break;

    case 'join':
      joinRoom();
      break;

    case 'copy-code':
      copyText(snapshot.code, '房间码已复制');
      break;

    case 'copy-link':
      copyText(`${location.origin}/?code=${snapshot.code}`, '邀请链接已复制');
      break;

    case 'reveal':
      ui.revealed = true;
      render();
      break;

    case 'hide-role':
      ui.revealed = false;
      render();
      break;

    case 'confirm':
      act('confirm_identity');
      break;

    case 'start-round':
      act('start_round');
      break;

    case 'start-voting':
      act('start_voting');
      break;

    case 'vote':
      if (confirm(`确认投给 ${seat} 号？提交后不能修改。`)) act('vote', { target: seat });
      break;

    case 'end-voting':
      if (confirm('现在结束投票并按当前票数结算？没投的人按弃权处理。')) act('end_voting');
      break;

    case 'clear-seat':
      if (confirm(`把 ${seat} 号座位清空？`)) act('clear_seat', { seat });
      break;

    case 'back-lobby':
      if (confirm('回到大厅？本轮结果会被清掉。')) act('back_to_lobby');
      break;

    case 'leave':
      if (confirm('确定退出房间？')) {
        act('leave').then((ok) => {
          // 只有服务端真的释放了座位，才清掉本地会话
          if (!ok) return;
          stopPolling();
          saveSession(null);
          snapshot = null;
          lastSig = '';
          ui.homeError = '';
          render();
        });
      }
      break;

    case 'toggle-detail':
      if (ev.target.tagName === 'SUMMARY') {
        ui.detailOpen = !ui.detailOpen;
      }
      break;

    default:
      break;
  }
});

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.id === 'create-name') {
    ui.createName = el.value;
    const submit = document.querySelector('[data-act="create"]');
    if (submit) submit.disabled = !el.value.trim();
  } else if (el.id === 'join-name') {
    ui.joinName = el.value;
    const submit = document.querySelector('[data-act="join"]');
    if (submit) submit.disabled = !(el.value.trim() && ui.joinSeat);
  } else if (el.id === 'join-code') {
    const digits = el.value.replace(/\D/g, '').slice(0, 4);
    if (digits !== el.value) el.value = digits;
    const changed = digits !== ui.joinCode;
    ui.joinCode = digits;
    if (digits.length < 4) {
      ui.joinPreview = null;
      ui.joinSeat = null;
      ui.joinError = '';
    }
    if (changed) lookupRoom(digits);
  }
});

/* ----------------------------- 启动 ----------------------------- */

function boot() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('code') || '').replace(/\D/g, '').slice(0, 4);

  session = loadSession();
  if (session) {
    render();
    startPolling();
    return;
  }
  if (code.length === 4) {
    ui.tab = 'join';
    ui.joinCode = code;
    render();
    lookupRoom(code);
    return;
  }
  render();
}

boot();
