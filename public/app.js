'use strict';

/* 内鬼模式 · 前端
 * 只有自己的身份会从服务端下发，页面里也不会缓存别人的身份。
 * 轮询间隔 1.2 秒；标签页在后台时降到 3 秒。 */

const STORAGE_KEY = 'lol-spy-session-v1';
const POLL_MS = 1200;
const IDLE_POLL_MS = 3000;

const MODES = {
  classic: {
    label: '经典模式',
    badge: '5V5 · 双方各一名内鬼',
    desc: '每队 1 名内鬼。平民投本队，内鬼去对面队伍里猜谁是对面的内鬼。',
    rules:
      '规则：1–5 号为 A 队，6–10 号为 B 队，每队各随机一名内鬼。游戏结束后队内投票，每人只能投本队其他人；' +
      '内鬼不能投本队，改成去对面 5 人里猜谁是对面的内鬼，这一票计入对面队伍的票数。' +
      '唯一最高票正好是内鬼则平民胜出，平票、投错人或无人投票则内鬼胜出。',
  },
  multi: {
    label: '多内鬼模式',
    badge: '5V5 · 每队随机 2~5 名内鬼',
    desc: '两队内鬼数量相同，随机 2~5 名。每人 2 票：平民投本队，内鬼猜对面。',
    rules:
      '规则：1–5 号为 A 队，6–10 号为 B 队，每队随机 2–5 名内鬼（两队数量相同）。' +
      '赛后每人 2 票、一次提交，必须投给两个不同的人：平民两票都投本队，' +
      '内鬼不能投本队，两票都去猜对面队伍的内鬼（这两票计入对面队伍的票数）。' +
      '结算公布全部内鬼、票数、票型和票数最高的内鬼，具体惩罚（比如红包）你们自己结算。',
  },
};

function modeInfo(mode) {
  return MODES[mode === 'multi' ? 'multi' : 'classic'];
}

const ui = {
  tab: 'create',
  mode: 'classic',
  picks: [],
  rulesOpen: false,
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

function rulesHtml(mode) {
  if (mode === 'multi') {
    return `
      <div class="rule-section">
        <h4>身份</h4>
        <ul>
          <li>1–5 号是 A 队，6–10 号是 B 队，一队一边。</li>
          <li>每队随机 <b>2~5 名内鬼</b>，<b>两队数量相同</b>，每轮重新随机；身份只有本人能看到。</li>
          <li>约定：内鬼的目标是<b>让自己队伍输掉真实比赛</b>，并尽量不被投出来。</li>
        </ul>
      </div>
      <div class="rule-section">
        <h4>投票（赛后）</h4>
        <ul>
          <li>每人 <b>2 票</b>、一次提交；两票必须投给<b>两个不同的人</b>，不能投自己。</li>
          <li>平民：两票都投<b>本队</b>的人。</li>
          <li>内鬼：不能投本队，两票都去<b>对面队伍</b>猜谁是对面的内鬼，<b>票计入对面队伍的票数</b>。</li>
          <li>全员投完时每队恒为 <b>10 票</b>（本队平民每人 2 票 + 对面内鬼每人 2 票），不随内鬼数量变化。</li>
          <li>投票过程中不显示任何票数；所有人投完（或房主提前结束）才公布。</li>
        </ul>
      </div>
      <div class="rule-section">
        <h4>判定</h4>
        <ul>
          <li><b>被投出</b> = 该内鬼是<b>本队最高票</b>（可以并列，至少 1 票）。</li>
          <li>结算页公布全部内鬼、每队票数排行、完整票型和票数最高的内鬼。</li>
        </ul>
      </div>
      <div class="rule-section">
        <h4>红包结算</h4>
        <ul>
          <li>内鬼所在队<b>赢了</b>，或该内鬼<b>被投出</b> → 该内鬼发 <b>5 个红包</b>，总额 = <b>6 − 内鬼数量</b>（2 人 4 元 / 3 人 3 元 / 4 人 2 元 / 5 人 1 元）。</li>
          <li>领包人 = <b>己方平民 + 对方内鬼</b>，共 5 人，一人一个包。</li>
          <li>内鬼所在队<b>输了且没被投出</b> → 该内鬼免罚；<b>平民不参与发红包</b>。</li>
          <li>房主在结算页（投票阶段也可以）点「A 队赢 / B 队赢」，App 自动生成清单；录错了可以点另一边改，也可以「撤回」重录，清单和历史记录会跟着重算。</li>
        </ul>
      </div>`;
  }
  return `
    <div class="rule-section">
      <h4>身份</h4>
      <ul>
        <li>1–5 号是 A 队，6–10 号是 B 队，一队一边。</li>
        <li>每队随机 <b>1 名内鬼</b>，连续当内鬼是允许的；身份只有本人能看到。</li>
        <li>约定：内鬼的目标是<b>让自己队伍输掉真实比赛</b>，并尽量不被投出来。</li>
      </ul>
    </div>
    <div class="rule-section">
      <h4>投票（赛后）</h4>
      <ul>
        <li>平民：只能投<b>本队</b>的人，不能投自己，每人 1 票。</li>
        <li>内鬼：不能投本队，改成在<b>对面 5 人</b>里猜谁是对面的内鬼，这一票<b>计入对面队伍的票数</b>。</li>
        <li>每队票数 = 本队平民 4 票 + 对面内鬼猜过来 1 票 = <b>5 票</b>。</li>
        <li>投票过程中不显示任何票数；所有人投完（或房主提前结束）才公布。</li>
      </ul>
    </div>
    <div class="rule-section">
      <h4>判定</h4>
      <ul>
        <li>唯一最高票正好是本队内鬼 → 内鬼<b>被投出</b>。</li>
        <li>平票 / 最高票是平民 / 无人投票 → 内鬼<b>没被投出</b>。</li>
      </ul>
    </div>
    <div class="rule-section">
      <h4>红包结算（单倍）</h4>
      <ul>
        <li>内鬼所在队<b>赢了</b>，或内鬼<b>被投出</b> → 内鬼发 <b>5 个红包（共 5 元）</b>，由<b>己方 4 个平民 + 对方内鬼</b>一人领 1 元。</li>
        <li>内鬼所在队<b>输了且没被投出</b> → 内鬼免罚；<b>没投中他的己方平民</b>每人给他发 1 元（弃权也算没投中）。</li>
        <li>房主在结算页（投票阶段也可以）点「A 队赢 / B 队赢」，App 自动生成清单；录错了可以点另一边改，也可以「撤回」重录，清单和历史记录会跟着重算。</li>
      </ul>
    </div>`;
}

/** 当前上下文该显示哪套规则：房间里看房间模式，首页看所选/查到的模式。 */
function currentRulesMode() {
  if (snapshot) return snapshot.mode;
  if (ui.tab === 'join' && ui.joinPreview) return ui.joinPreview.mode;
  return ui.mode;
}

function renderModal() {
  const el = document.getElementById('modal');
  if (!el) return;
  if (!ui.rulesOpen) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const mode = currentRulesMode();
  el.hidden = false;
  el.innerHTML = `
    <div class="modal-dialog" data-act="modal-body">
      <div class="modal-head">
        <h3>规则 · ${modeInfo(mode).label}</h3>
        <button class="small ghost" data-act="close-rules">关闭</button>
      </div>
      ${rulesHtml(mode)}
      <p class="muted" style="margin-top:14px">身份和票数只存在服务端，接口只下发你自己的身份，结算前谁也看不到别人的身份和票数。模式在建房时选定，房间内不能更换。</p>
    </div>`;
}

function render() {
  const focus = captureFocus();
  let html;
  if (session && !snapshot) html = renderLoading();
  else if (snapshot) html = renderRoom(snapshot);
  else html = renderHome();
  document.getElementById('app').innerHTML = html;
  renderModal();
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
  const previewMode = ui.tab === 'join' ? (ui.joinPreview ? ui.joinPreview.mode : null) : ui.mode;
  const info = previewMode ? modeInfo(previewMode) : null;
  return `
    <header class="hero">
      <div class="badge">${info ? info.badge : '5V5 · 内鬼模式'}</div>
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
      ${info ? info.rules : MODES.classic.rules}
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
    <div class="muted" style="margin-bottom:6px">选择模式</div>
    <div class="row" style="margin-bottom:10px">
      <button class="${ui.mode === 'classic' ? '' : 'ghost'} grow" data-act="pick-mode" data-mode="classic">经典模式</button>
      <button class="${ui.mode === 'multi' ? '' : 'ghost'} grow" data-act="pick-mode" data-mode="multi">多内鬼模式</button>
    </div>
    <p class="muted" style="margin-bottom:10px">${modeInfo(ui.mode).desc}</p>
    <button class="small ghost" data-act="rules" style="margin-bottom:16px">查看规则</button>
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
        ? `<p class="muted" style="margin-bottom:10px">房间模式：<b>${modeInfo(preview.mode).label}</b> — ${modeInfo(
            preview.mode,
          ).desc}</p>
           <button class="small ghost" data-act="rules" style="margin-bottom:12px">查看规则</button>
           <div class="muted" style="margin-bottom:6px">点一个空座位坐下</div>${seatPicker(
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
      <button class="small ghost" data-act="rules">规则</button>
      <button class="small ghost" data-act="copy-code">复制房间码</button>
      <button class="small ghost" data-act="copy-link">复制邀请链接</button>
    </div>
    <p class="muted" style="margin-top:10px">
      <span class="mode-tag ${s.mode === 'multi' ? 'multi' : 'classic'}">${modeInfo(s.mode).label}</span>你是
      ${s.seat} 号 · ${esc(s.name || '')} · ${s.team} 队${s.isHost ? ' · 房主' : ''}
      ${s.round > 0 ? ` · 第 ${s.round} 轮` : ''}
    </p>`;
}

function seatTags(seat) {
  const tags = [];
  if (seat.confirmed) tags.push('<span class="tag-ok">已确认</span>');
  if (seat.hasVoted) tags.push('<span class="tag-ok">已投票</span>');
  return tags.length ? `<div class="tags">${tags.join('')}</div>` : '';
}

/** 列出还没完成某个动作（确认身份 / 投票）的人，格式：`3 号 老王`。 */
function pendingNames(seats, flagKey) {
  return seats
    .filter((seat) => seat.occupied && !seat[flagKey])
    .map((seat) => `${seat.seat} 号${seat.name ? ` ${esc(seat.name)}` : ''}`);
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
      <p class="muted">${
        s.mode === 'multi' ? '本局每队随机 2~5 名内鬼（两边数量相同），每人 2 票。' : '本局每队各一名内鬼。'
      }把房间码发给同局的朋友，10 个人到齐后由房主开始。</p>
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
             <p class="muted" style="margin-top:10px">${
               s.mode === 'multi'
                 ? '点击后每队随机产生 2~5 名内鬼（两边数量相同），所有人各自查看自己的身份。'
                 : '点击后每队随机产生一名内鬼，所有人各自查看自己的身份。'
             }</p>
           </div>`
        : `<div class="status-line"><span class="spinner"></span>等待房主开始本轮</div>`
    }`;
}

function identityCard(s) {
  const me = s.seats.find((seat) => seat.isMe);
  const multi = s.mode === 'multi';
  if (ui.revealed && s.myRole) {
    const isSpy = s.myRole === 'spy';
    const hint = isSpy
      ? multi
        ? '你是内鬼。别被队友发现——赛后你的 2 票都要投给对面队伍。'
        : '你不能投本队，要去对面队伍里猜谁是对面的内鬼，那一票计入对面队伍的票数。别露馅。'
      : multi
        ? '本队有 2~5 名内鬼（数量随机）。赛后你有 2 票，从本队里选出 2 个最可疑的人。'
        : '在你们队里找出那个内鬼。';
    return `
      <div class="identity-card ${isSpy ? 'spy' : 'villager'}">
        <div class="role-word ${isSpy ? 'spy' : 'villager'}">${isSpy ? '你是内鬼' : '你是平民'}</div>
        <div class="role-hint">${hint}</div>
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
  const pendingList = pendingNames(s.seats, 'confirmed');
  return `
    <div class="phase-title">
      <h2>第 ${s.round} 轮 · 看身份</h2>
      <p class="muted">身份只有你自己的屏幕上能看到，看完请点确认。${
        s.mode === 'multi' ? '本局每队随机 2~5 名内鬼，每人 2 票。' : ''
      }</p>
    </div>
    ${identityCard(s)}
    <div class="status-line">已确认 ${s.confirmedCount}/${s.occupiedCount}${
      pending > 0 ? ` · 还没确认：${pendingList.join('、')}` : ' · 所有人都确认了'
    }</div>
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
                 : `还有 ${pending} 人没确认身份：${pendingList.join('、')}，等他们看完再开始投票。`
             }</p>
           </div>`
        : `<div class="status-line"><span class="spinner"></span>等待房主开启投票</div>`
    }`;
}

function renderVoting(s) {
  const multi = s.mode === 'multi';
  const targets = s.voteTargets;
  const myTargets = multi && Array.isArray(s.myVoteTargets) ? s.myVoteTargets : [];
  const voted = multi ? myTargets.length > 0 : s.myVoteTarget != null;
  const waiting = s.occupiedCount - s.votesSubmittedCount;
  const waitingList = pendingNames(s.seats, 'hasVoted');
  const label = (seat) => {
    const info = s.seats[seat - 1];
    return `${seat} 号${info && info.name ? ` ${esc(info.name)}` : ''}`;
  };
  const targetName = voted && !multi ? s.seats[s.myVoteTarget - 1] : null;

  let ballot;
  if (multi) {
    if (voted) {
      ballot = `
      <div class="card${s.isSpyBallot ? ' spy-note' : ''}">
        <div class="status-line" style="margin-top:0">
          <span class="spinner"></span>你已提交：<b>${myTargets.map(label).join('、')}</b> · 等待其他人（已投 ${s.votesSubmittedCount}/${s.occupiedCount}）
        </div>
        <p class="muted" style="margin-top:10px;text-align:center">两票一起提交，提交后不能修改。</p>
      </div>`;
    } else {
      const picks = ui.picks;
      ballot = `
      <div class="card${s.isSpyBallot ? ' spy-note' : ''}">
        ${
          s.isSpyBallot
            ? `<div class="spy-note-title">你是内鬼 · 两票都投对面</div>
               <p class="muted">两票都投给对面队伍的人（不能重复）。票会计入对面队伍的票数——猜中就是给对面的内鬼加票。</p>`
            : ''
        }
        <div class="muted" style="margin:8px 0 4px">${s.isSpyBallot ? '对面队伍候选人' : '本队候选人'}（选 2 人）</div>
        <div class="menu">
          ${targets
            .map((t) => {
              const picked = picks.includes(t.seat);
              return `<button data-act="pick-vote" data-seat="${t.seat}" class="${
                picked ? 'picked' : ''
              }">${t.seat} 号 · ${esc(t.name)}${picked ? ' ✓' : ''}</button>`;
            })
            .join('')}
        </div>
        <div class="status-line">已选 ${picks.length}/2</div>
        <button class="primary" style="margin-top:10px" data-act="submit-votes" ${
          picks.length === 2 ? '' : 'disabled'
        }>提交我的 2 票</button>
      </div>`;
    }
  } else if (s.isSpyBallot) {
    ballot = voted
      ? `
      <div class="card spy-note">
        <div class="spy-note-title">你的猜测已提交</div>
        <p class="muted">你猜 <b>${targetName ? `${targetName.seat} 号 ${esc(targetName.name)}` : ''}</b>
        是对方队伍的内鬼。提交后不能修改，等其他人投完就会自动结算。</p>
        <div class="status-line">已投 ${s.votesSubmittedCount}/${s.occupiedCount}</div>
      </div>`
      : `
      <div class="card spy-note">
        <div class="spy-note-title">你是内鬼 · 去猜对面谁是内鬼</div>
        <p class="muted">你不能投本队的人，改成在对面这 5 个人里挑一个你认为是内鬼的。
        这一票会<b>计入对面队伍的票数</b>——猜中就是给对面内鬼加一票。结算时还会公布你猜得准不准。</p>
        <div class="menu">
          ${targets
            .map(
              (t) => `<button data-act="vote" data-seat="${t.seat}">${t.seat} 号 · ${esc(t.name)}</button>`,
            )
            .join('')}
        </div>
      </div>`;
  } else if (voted) {
    ballot = `
      <div class="card">
        <div class="status-line" style="margin-top:0">
          <span class="spinner"></span>你已投给 <b>${esc(targetName ? targetName.name : '')}</b> · 等待其他人（已投 ${s.votesSubmittedCount}/${s.occupiedCount}）
        </div>
        <p class="muted" style="margin-top:10px;text-align:center">投票提交后不能修改。</p>
      </div>`;
  } else {
    ballot = `
      <div class="card">
        <div class="muted" style="margin-bottom:4px">本队候选人</div>
        <div class="menu">
          ${targets
            .map(
              (t) => `<button data-act="vote" data-seat="${t.seat}">${t.seat} 号 · ${esc(t.name)}</button>`,
            )
            .join('')}
        </div>
      </div>`;
  }

  return `
    <div class="phase-title">
      <h2>第 ${s.round} 轮 · ${s.isSpyBallot ? '猜对面内鬼' : '队内投票'}</h2>
      <p class="muted">${
        multi
          ? s.isSpyBallot
            ? `你是内鬼，两票都投给 ${s.team === 'A' ? 'B' : 'A'} 队的两个人（不能重复），票计入对面队伍的票数。所有人投完才会公布结果。`
            : `你是 ${s.team} 队，从本队里选 2 个最可疑的人（不能重复、不能选自己）。所有人投完才会公布结果。`
          : s.isSpyBallot
            ? `你是内鬼，去 ${s.team === 'A' ? 'B' : 'A'} 队的 5 个人里猜谁是对面的内鬼。所有人投完才会公布结果。`
            : `你是 ${s.team} 队，从本队里投出你认为的内鬼。所有人投完才会公布票数。`
      }</p>
    </div>
    ${ballot}
    ${
      s.isSpyBallot
        ? ''
        : `<details ${ui.detailOpen ? 'open' : ''} data-act="toggle-detail">
             <summary>查看我的身份</summary>
             <p class="muted" style="margin-top:8px">你是${s.myRole === 'spy' ? '内鬼' : '平民'}（${s.team} 队 ${s.seat} 号）。</p>
           </details>`
    }
    ${
      s.isHost
        ? `<div class="host-panel">
             <div class="label">房主操作</div>
             <button class="ghost" data-act="end-voting">提前结束投票并结算</button>
             <p class="muted" style="margin-top:10px">${
               waiting > 0
                 ? `还有 ${waiting} 人没投票：${waitingList.join('、')}，没投的按弃权处理。`
                 : '所有人都投完了。'
             }</p>
           </div>`
        : waiting > 0
          ? `<div class="status-line">还没投票：${waitingList.join('、')}</div>`
          : ''
    }`;
}

const VERDICTS = {
  caught: { title: '抓到内鬼 · 平民胜出', cls: 'win-villagers', desc: '唯一最高票正好是内鬼。' },
  tie: { title: '平票 · 内鬼胜出', cls: 'win-spy', desc: '出现并列最高票，按规则内鬼胜出。' },
  wrong_person: { title: '投错人 · 内鬼胜出', cls: 'win-spy', desc: '最高票是一位平民，内鬼溜了。' },
  no_votes: { title: '无人投票 · 内鬼胜出', cls: 'win-spy', desc: '这一队一张票都没有。' },
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

  const teamSeatsOf = (t) => (t === 'A' ? [1, 2, 3, 4, 5] : [6, 7, 8, 9, 10]);
  const teamBallots = (s.outcome.ballots || []).filter((b) => teamSeatsOf(team).includes(b.voter));
  const voteRows = teamBallots
    .map((b) => {
      const targetIsSpy = b.target === s.outcome.A.spy || b.target === s.outcome.B.spy;
      const tag = b.bySpy
        ? `<span class="vote-tag spy">内鬼票 · 计入 ${b.countsIn} 队</span>`
        : '<span class="vote-tag ok">平民票</span>';
      return `<div class="vote-row${b.bySpy ? ' by-spy' : ''}">
        <span class="vote-from">${b.voter} 号 ${esc(b.voterName)}${b.bySpy ? ' 🔪' : ''}</span>
        <span class="vote-arrow">→</span>
        <span class="vote-to">${b.target} 号 ${esc(b.targetName)}${targetIsSpy ? ' 🔪' : ''}</span>
        ${tag}
      </div>`;
    })
    .join('');

  return `
    <div class="verdict ${verdict.cls}">
      <div class="verdict-head">
        <div class="verdict-title">${team} 队 · ${verdict.title}${
          team === s.team ? '<span class="mine-tag">你的队</span>' : ''
        }</div>
        <div class="muted">计入票数 ${o.countedVotes}</div>
      </div>
      <div class="conclusion">${conclusionText(s, o)}</div>
      ${verdict.desc ? `<p class="muted" style="margin-top:6px">${verdict.desc}</p>` : ''}
      <div class="tally">${rows}</div>
      <div class="vote-detail">
        <div class="vote-detail-head">本队投票情况</div>
        ${voteRows || '<p class="muted">本队没有人投票</p>'}
      </div>
    </div>`;
}

/** 一句话说清：最高票是谁、他是不是内鬼。 */
function conclusionText(s, o) {
  const who = (seat) => {
    const occupied = s.seats[seat - 1];
    const name = occupied && occupied.name ? ` ${esc(occupied.name)}` : '';
    return `${seat} 号${name}`;
  };
  const spy = `<span class="spy-name">${who(o.spy)}</span>`;

  if (o.reason === 'caught') {
    return `最高票 <b>${who(o.leaders[0])}</b>（${o.topCount} 票），<b class="ok-text">正是内鬼</b> ✅`;
  }
  if (o.reason === 'tie') {
    const names = o.leaders.map(who).join('、');
    const count = o.topCount > 0 ? `各 ${o.topCount} 票` : '都是 0 票';
    return `最高票并列 <b>${names}</b>（${count}），平票判不出结论；内鬼是 ${spy}`;
  }
  if (o.reason === 'no_votes') {
    return `这一队一张票都没有；内鬼是 ${spy}`;
  }
  return `最高票 <b>${who(o.leaders[0])}</b>（${o.topCount} 票），<b class="bad-text">是平民</b>；内鬼其实是 ${spy}`;
}

function renderResult(s) {
  if (s.mode === 'multi') return renderResultMulti(s);
  return `
    <div class="phase-title">
      <h2>第 ${s.round} 轮 · 结算</h2>
      <p class="muted">左边 A 队、右边 B 队，各算各的。每队票数 = 本队平民的 4 票 + 对面内鬼猜过来的 1 票。</p>
    </div>
    <div class="result-columns">
      ${renderTeamResult(s, 'A')}
      ${renderTeamResult(s, 'B')}
    </div>
    ${renderSpyGuesses(s)}
    ${renderSettlement(s)}
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

/** 房主录比赛结果 + 自动生成的红包清单（单倍结算，两种模式都支持）。 */
function renderSettlement(s) {
  const winner = s.matchWinner;
  const pickButtons = `
    <div class="row" style="margin-top:10px">
      <button class="${winner === 'A' ? '' : 'ghost'} grow" data-act="set-winner" data-winner="A">A 队赢</button>
      <button class="${winner === 'B' ? '' : 'ghost'} grow" data-act="set-winner" data-winner="B">B 队赢</button>
      ${winner ? '<button class="ghost small" data-act="clear-winner">撤回</button>' : ''}
    </div>`;

  let body;
  if (!winner) {
    body = s.isHost
      ? `<p class="muted">打完比赛后，点一下哪队赢了，下面就会生成红包清单。</p>${pickButtons}`
      : '<p class="muted">等待房主录入比赛结果…</p>';
  } else {
    body = `${s.settlement ? renderSettlementList(s.settlement) : '<p class="muted">正在计算红包清单…</p>'}
      <p class="muted" style="margin-top:12px">本局赢家：<b>${winner} 队</b>${
        s.isHost ? '（点下面可以改，录错了也可以撤回重录）' : ''
      }</p>
      ${s.isHost ? pickButtons : ''}`;
  }

  return `
    <div class="card settlement-card">
      <h3>比赛结果 · 红包清单</h3>
      ${body}
      <p class="muted" style="margin-top:12px">${
        s.mode === 'multi'
          ? '多内鬼模式：每个内鬼发 5 个红包，总额 = 6 − 内鬼数量（5 人 1 元 / 4 人 2 元 / 3 人 3 元 / 2 人 4 元）；平民不用发。'
          : '按单倍结算，暂不含「被投出双倍」。'
      }</p>
    </div>`;
}

function renderSettlementList(settlement) {
  return (settlement.entries || [])
    .map((entry) => {
      const spy = `${entry.spy.seat} 号 ${esc(entry.spy.name)}`;
      if (entry.action === 'pay') {
        const receivers = entry.receivers.map((r) => `${r.seat} 号 ${esc(r.name)}`).join('、');
        const why = entry.teamWon
          ? `${entry.team} 队赢了比赛`
          : `${entry.team} 队输了，但内鬼被投出`;
        const each = entry.amount / entry.packets;
        return `<div class="settle-row">
          <div class="settle-title"><span class="spy-name">${spy}</span> 发 ${entry.packets} 个红包（共 ${entry.amount} 元）</div>
          <div class="muted">原因：${why}｜每个包 ${each} 元，领包人：${receivers || '（没有可领的人）'}</div>
        </div>`;
      }
      if (entry.action === 'free') {
        return `<div class="settle-row">
          <div class="settle-title"><span class="spy-name">${spy}</span> 免罚</div>
          <div class="muted">原因：${entry.team} 队输了且内鬼没被投出</div>
        </div>`;
      }
      const payers = entry.payers.length
        ? entry.payers.map((p) => `${p.seat} 号 ${esc(p.name)}`).join('、')
        : '（没有平民漏投）';
      return `<div class="settle-row">
        <div class="settle-title"><span class="spy-name">${spy}</span> 免罚，收 ${entry.amount} 元</div>
        <div class="muted">原因：${entry.team} 队输了且内鬼没被投出｜没投中他的平民每人给他 1 元：${payers}</div>
      </div>`;
    })
    .join('');
}

/** 多内鬼模式的单队结算：只公布数据（内鬼名单、票数、票型、票数最高的内鬼）。 */
function renderTeamResultMulti(s, team) {
  const o = s.outcome[team];
  const max = Math.max(o.topCount, 1);
  const spySet = new Set(o.spies);
  const topSet = new Set(o.topSpies);
  const who = (seat) => {
    const meta = s.seats[seat - 1];
    return `${seat} 号${meta && meta.name ? ` ${esc(meta.name)}` : ''}`;
  };

  const rows = Object.keys(o.counts)
    .map(Number)
    .sort((a, b) => o.counts[b] - o.counts[a] || a - b)
    .map((seat) => {
      const cls = ['tally-row'];
      if (spySet.has(seat)) cls.push('is-spy');
      if (topSet.has(seat)) cls.push('is-leader');
      return `<div class="${cls.join(' ')}">
        <div class="tally-name">${topSet.has(seat) ? '⭐ ' : ''}${who(seat)}${
          spySet.has(seat) ? ' 🔪' : ''
        }</div>
        <div class="bar"><span style="width:${Math.round((o.counts[seat] / max) * 100)}%"></span></div>
        <div class="count">${o.counts[seat]}</div>
      </div>`;
    })
    .join('');

  // 每队票数 = 本队平民的票 + 对面内鬼猜过来的票，所以列的是"算进本队"的所有票
  const ballots = (s.outcome.ballots || []).filter((b) => b.countsIn === team);
  const voteRows = ballots
    .map(
      (b) => `<div class="vote-row${b.bySpy ? ' by-spy' : ''}">
        <span class="vote-from">${b.voter} 号 ${esc(b.voterName)}${b.bySpy ? ' 🔪' : ''}</span>
        <span class="vote-arrow">→</span>
        <span class="vote-to">${b.target} 号 ${esc(b.targetName)}${spySet.has(b.target) ? ' 🔪' : ''}${
          b.bySpy && spySet.has(b.target) ? ' 🎯' : ''
        }</span>
        ${
          b.bySpy
            ? `<span class="vote-tag spy">内鬼票 · ${b.voter <= 5 ? 'A' : 'B'} 队猜的</span>`
            : '<span class="vote-tag ok">平民票</span>'
        }
      </div>`,
    )
    .join('');

  const topLine = o.topSpies.length
    ? `票数最高的内鬼：<b class="spy-name">${o.topSpies.map(who).join('、')}</b>（${o.topCount} 票）`
    : '内鬼一张票都没拿到';

  return `
    <div class="verdict">
      <div class="verdict-head">
        <div class="verdict-title">${team} 队${team === s.team ? '<span class="mine-tag">你的队</span>' : ''}</div>
        <div class="muted">有效票数 ${o.countedVotes}</div>
      </div>
      <div class="conclusion">
        本队内鬼 ${o.spies.length} 名：<b class="spy-name">${o.spies.map(who).join('、')}</b><br>${topLine}
      </div>
      <div class="tally">${rows}</div>
      <div class="vote-detail">
        <div class="vote-detail-head">本队得票明细（含对面内鬼猜过来的票）</div>
        ${voteRows || '<p class="muted">本队一张票都没有</p>'}
      </div>
    </div>`;
}

function renderResultMulti(s) {
  return `
    <div class="phase-title">
      <h2>第 ${s.round} 轮 · 结算</h2>
      <p class="muted">每队随机 2~5 名内鬼（数量相同），每人 2 票。下面是全部身份、票数和红包清单。</p>
    </div>
    <div class="result-columns">
      ${renderTeamResultMulti(s, 'A')}
      ${renderTeamResultMulti(s, 'B')}
    </div>
    ${renderSettlement(s)}
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

function renderSpyGuesses(s) {
  const ballots = s.outcome.ballots || [];
  const spyA = s.outcome.A.spy;
  const spyB = s.outcome.B.spy;

  const line = (mySeat, oppSeat, myTeam) => {
    const guess = ballots.find((b) => b.voter === mySeat);
    if (!guess) return '';
    const hit = guess.target === oppSeat;
    return `<div class="hist-line">
      <span class="hist-team t${myTeam.toLowerCase()}">${myTeam} 队内鬼</span>
      <span>${mySeat} 号 ${esc(guess.voterName)} 猜 ${guess.target} 号 ${esc(guess.targetName)}</span>
      <span class="hist-verdict ${hit ? 'win' : 'lose'}">${
        hit ? '猜中了对方内鬼 🎯' : `猜错了（对面是 ${oppSeat} 号）`
      }</span>
    </div>`;
  };

  return `
    <div class="card spy-guesses-card">
      <h3>内鬼互猜</h3>
      <div style="margin-top:10px">
        ${line(spyA, spyB, 'A')}
        ${line(spyB, spyA, 'B')}
      </div>
      <p class="muted" style="margin-top:12px">
        带 🔪 的是内鬼。内鬼不能投本队，那一票改成猜对面队伍的内鬼，并且<b>计入对面队伍的票数</b>。
      </p>
    </div>`;
}

function renderHistory(s) {
  const history = s.history || [];
  if (!history.length) return '';

  const rounds = history
    .slice()
    .reverse()
    .map((h) => {
      const line = (team) => {
        const o = h[team];
        if (h.mode === 'multi') {
          const spies = o.spies.map((sp) => `${sp.seat} 号 ${esc(sp.name)}`).join('、');
          const top = o.topSpies.length
            ? `票数最高的内鬼：${o.topSpies
                .map((sp) => `${sp.seat} 号 ${esc(sp.name)}`)
                .join('、')}（${o.topCount} 票）`
            : '内鬼无人得票';
          const settleEntries = h.settlement ? (h.settlement.entries || []).filter((e) => e.team === team) : [];
          const paid = settleEntries
            .filter((e) => e.action === 'pay')
            .reduce((sum, e) => sum + e.amount, 0);
          const settleText = settleEntries.length ? (paid > 0 ? `发 ${paid} 元红包` : '全员免罚') : '';
          return `<div class="hist-line">
            <span class="hist-team t${team.toLowerCase()}">${team} 队</span>
            <span>内鬼 <b class="spy-name">${spies}</b></span>
            <span>${top}</span>
            <span class="muted">有效 ${o.countedVotes} 票</span>
            ${settleText ? `<span class="muted">${settleText}</span>` : ''}
          </div>`;
        }
        const verdict = VERDICTS[o.reason] || VERDICTS.wrong_person;
        const win = verdict.cls === 'win-villagers';
        const settle = h.settlement && (h.settlement.entries || []).find((e) => e.team === team);
        return `<div class="hist-line">
          <span class="hist-team t${team.toLowerCase()}">${team} 队</span>
          <span>内鬼 <b class="spy-name">${o.spy.seat} 号 ${esc(o.spy.name)}</b></span>
          <span class="hist-verdict ${win ? 'win' : 'lose'}">${verdict.title}</span>
          <span class="muted">计入 ${o.countedVotes} 票</span>
          ${
            settle
              ? `<span class="muted">${
                  settle.action === 'pay' ? `发 ${settle.amount} 元红包` : `收 ${settle.amount} 元`
                }</span>`
              : ''
          }
        </div>`;
      };
      return `<div class="hist-round">
        <div class="hist-head">第 ${h.round} 轮${h.matchWinner ? ` · ${h.matchWinner} 队赢` : ''}</div>
        ${line('A')}
        ${line('B')}
      </div>`;
    })
    .join('');

  return `
    <details class="history">
      <summary>历史战绩（共 ${history.length} 轮，最近的在最上面）</summary>
      <div class="hist-body">${rounds}</div>
    </details>`;
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
    ${renderHistory(s)}
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
  if (!prev || prev.round !== state.round || prev.phase !== state.phase) {
    ui.revealed = false;
    ui.detailOpen = false;
    ui.picks = [];
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
      body: { name: ui.createName.trim(), seat: ui.createSeat, mode: ui.mode },
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

    case 'rules':
      ui.rulesOpen = true;
      render();
      break;

    case 'close-rules':
      ui.rulesOpen = false;
      render();
      break;

    case 'pick-mode':
      ui.mode = btn.dataset.mode === 'multi' ? 'multi' : 'classic';
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

    case 'pick-vote': {
      if (ui.picks.includes(seat)) ui.picks = ui.picks.filter((x) => x !== seat);
      else if (ui.picks.length >= 2) toast('已经选满 2 个人，先点掉一个再选');
      else ui.picks = ui.picks.concat(seat);
      render();
      break;
    }

    case 'submit-votes': {
      if (ui.picks.length !== 2) break;
      const picks = ui.picks.slice();
      if (confirm(`确认投给 ${picks[0]} 号和 ${picks[1]} 号？两票一起提交，提交后不能修改。`)) {
        act('vote', { targets: picks }).then((ok) => {
          if (ok) ui.picks = [];
        });
      }
      break;
    }

    case 'end-voting':
      if (confirm('现在结束投票并按当前票数结算？没投的人按弃权处理。')) act('end_voting');
      break;

    case 'set-winner':
      act('set_match_winner', { winner: btn.dataset.winner });
      break;

    case 'clear-winner':
      if (confirm('撤回比赛结果？红包清单会一起清掉，之后可以重新录。')) {
        act('set_match_winner', { winner: null });
      }
      break;

    case 'clear-seat':
      if (
        confirm(
          snapshot.phase === 'reveal'
            ? `把 ${seat} 号座位清空？\n\n现在是「看身份」阶段，身份已经发下去了，清空会让本轮作废、所有人退回大厅重新开局。\n\n如果只是掉线，建议先等一下，对方刷新页面就能回到原座位。`
            : `把 ${seat} 号座位清空？`,
        )
      ) {
        act('clear_seat', { seat });
      }
      break;

    case 'back-lobby':
      if (confirm('回到大厅？本轮结果会被清掉。')) act('back_to_lobby');
      break;

    case 'leave':
      if (
        confirm(
          snapshot.phase === 'reveal'
            ? '确定退出房间？\n\n现在是「看身份」阶段，你退出会让本轮作废、所有人退回大厅重新开局。\n\n如果只是页面卡了，直接刷新就好，座位和身份都还在。'
            : '确定退出房间？',
        )
      ) {
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

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && ui.rulesOpen) {
    ui.rulesOpen = false;
    render();
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
