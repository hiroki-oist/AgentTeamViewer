// ボード描画。
//   ライブ: オーケストレータ（orchestrator/cli.js）から /api/events で状態を受け取り、そのまま描く
//   デモ:   サーバーがない（index.html を直接開いた等）ときはダミー状態 + シミュレーション
// ボードは状態を「表示」するだけで決定はしない。操作はオーケストレータに POST する。
(() => {
  const { locks, watchdog } = ATV;
  let state = ATV.dummyState();
  let live = false;
  let simTimer = null;
  let simClock = new Date('2026-09-28T22:20:00+09:00');
  let openEpic = null;

  const EFFORT_PIPS = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };
  const TASK_ICON = { todo: '○', running: '◐', review: '◑', done: '●', failed: '✕', blocked: '⏸', critique: '⚔' };
  const STATUS_LABEL = { ok: '✓ OK', warn: '▲ WARN', crit: '✕ CRIT' };
  const ALERT_ICON = { ok: '✓', warn: '▲', crit: '✕' };
  const RUN_LABEL = { starting: '起動中', planning: '計画中', running: '実行中', paused: '一時停止', 'waiting-human': '人間待ち', stuck: '行き詰まり', 'budget-stopped': '予算で停止', 'plan-limit': '利用枠で停止', 'protect-hold': '保護パスで停止', restarting: '再起動中', done: '完了', failed: '失敗' };
  const CRITIC_VERDICT = { change_approach: 'やり方を変える', task_is_wrong: 'task を定義し直す', needs_human: '人間の判断が必要' };
  const REQ_KIND = { install: 'インストール', auth: '認証', access: '権限', decision: '判断', other: 'その他' };

  const { riskScore } = ATV.policy;
  const route = (risk, failures) => ATV.policy.route(risk, failures);
  const escalate = (a) => ATV.policy.escalate(a);

  // ---------- 小物 ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // `code` だけ整形する（依頼の手順にコマンドが入るため）
  const richText = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
  const fmtK = watchdog.fmtK;
  const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : fmtK(n));
  const hhmm = (d) => d.toTimeString().slice(0, 5);
  const oneLine = (s, n) => { const x = String(s ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n)}…` : x; };
  const RESULT_LABEL = { ok: '成功', fail: '失敗', blocked: '人間待ち', interrupted: '中断', running: '実行中' };

  // ---------- 進み具合と所要時間の見込み ----------
  const minsSince = (iso) => (iso ? (now() - new Date(iso)) / 60000 : 0);
  const lastAttempt = (t) => t.attempts[t.attempts.length - 1];
  // 完了した task の所要時間（最初の試行の開始 → 最後の試行の終了）。run 全体の平均を見込みに使う
  function avgTaskMin() {
    const d = state.epics.flatMap((e) => e.tasks).filter((t) => t.status === 'done' && t.attempts.length)
      .map((t) => (new Date(lastAttempt(t).endedAt || lastAttempt(t).startedAt) - new Date(t.attempts[0].startedAt)) / 60000).filter((x) => x > 0);
    return d.length ? d.reduce((a, b) => a + b, 0) / d.length : null;
  }
  // 実行中の task の見込み: 手順の進みから比例で出す。手順がまだなら run の平均との差
  function taskEta(t) {
    const a = lastAttempt(t);
    if (!a || a.result !== 'running') return null;
    const el = minsSince(a.startedAt);
    const st = a.progress?.steps || [];
    const done = st.filter((x) => x.done).length;
    if (st.length && done) return { el, left: (el / done) * (st.length - done), done, total: st.length, basis: '手順' };
    const avg = avgTaskMin();
    return { el, left: avg != null ? Math.max(avg - el, 1) : null, done, total: st.length, basis: '平均' };
  }
  // 中プロジェクトの残りの見込み: 実行中の最長 + 未着手ぶん（同時数で割る）
  function epicEta(e) {
    const todo = e.tasks.filter((t) => ['todo', 'blocked', 'critique'].includes(t.status)).length;
    const running = e.tasks.filter((t) => t.status === 'running').map(taskEta).filter(Boolean);
    const avg = avgTaskMin();
    if (!todo && !running.length) return null;
    const runLeft = running.length ? Math.max(...running.map((x) => x.left ?? avg ?? 0)) : 0;
    const par = Math.max(1, Math.min(state.watchdog.limits.maxActiveAgents, todo));
    const todoLeft = avg != null ? Math.ceil(todo / par) * avg : null;
    return { todo, running: running.length, left: todoLeft == null && !running.length ? null : runLeft + (todoLeft || 0), avg };
  }
  function progressBlock(a) {
    const st = a.progress?.steps || [];
    if (!st.length && !a.progress?.now) return '';
    const firstOpen = st.findIndex((x) => !x.done);
    return `<ol class="steps">${st.map((x, i) => `<li class="${x.done ? 'done' : i === firstOpen && a.result === 'running' ? 'now' : ''}">${x.done ? '✓' : i === firstOpen && a.result === 'running' ? '▶' : '○'} ${esc(x.title)}</li>`).join('')}</ol>${a.progress?.now && a.result === 'running' ? `<div class="now-doing">いま: ${esc(a.progress.now)}</div>` : ''}`;
  }
  const mdhm = (d) => `${d.getMonth() + 1}/${d.getDate()} ${hhmm(d)}`;
  // 残り時間を短く: 45分 / 13時間20分 / 2日5時間
  const fmtDur = (min) => {
    if (!isFinite(min)) return '—';
    if (min < 60) return `${Math.max(0, Math.round(min))}分`;
    if (min < 48 * 60) return `${Math.floor(min / 60)}時間${Math.round(min % 60)}分`;
    return `${Math.floor(min / 1440)}日${Math.round((min % 1440) / 60)}時間`;
  };
  // 監視パネルの値: 主（大きめ）+ 補足（小さく、折り返してよい）
  const setStat = (sel, main, sub = '', title = '') => {
    const el = $(sel);
    el.innerHTML = `<b>${esc(main)}</b>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}`;
    el.title = title || `${main}${sub ? ` ${sub}` : ''}`;
  };
  const now = () => (live ? new Date() : simClock);
  const allTasks = () => state.epics.flatMap((e) => e.tasks.map((t) => ({ t, e })));

  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) alert((await r.json().catch(() => ({}))).error || `失敗: ${r.status}`);
  }

  function chip(agentId) {
    const a = agentId && state.agents[agentId];
    if (!a) return '<span class="agent-chip none">未割当</span>';
    const pips = Array.from({ length: 4 }, (_, i) => `<b class="${i < (EFFORT_PIPS[a.effort] || 0) ? 'on' : ''}"></b>`).join('');
    return `<span class="agent-chip" title="${esc(agentId)} (${a.role}, ${a.state})"><span class="dot" style="--c: var(--m-${esc(a.model)})"></span>${esc(a.model)}·${esc(a.effort)}<span class="pips">${pips}</span></span>`;
  }

  // ---------- 描画 ----------
  function render() {
    const lockInfo = locks.compute(state);
    const wd = watchdog.evaluate(state, lockInfo);
    renderHeader();
    renderWatchdog(wd);
    renderBoard(lockInfo);
    renderRequests();
    renderLocks(lockInfo);
    renderEvents();
    if (openEpic && $('#detail').open) openDetail(openEpic, true);
    return wd;
  }

  function renderHeader() {
    const p = state.project;
    $('#proj-id').textContent = p.id;
    $('#proj-name').textContent = p.name;
    $('#proj-goal').textContent = p.goal;
    $('#proj-criteria').innerHTML = (p.successCriteria || []).map((c) => `<li>${esc(c)}</li>`).join('');
    const tasks = state.epics.flatMap((e) => e.tasks);
    const done = tasks.filter((t) => t.status === 'done').length;
    $('#proj-progress').style.width = `${tasks.length ? (done / tasks.length) * 100 : 0}%`;
    const epicsDone = state.epics.filter((e) => e.status === 'done').length;
    $('#proj-progress-label').textContent = `task ${done}/${tasks.length} · 中プロジェクト ${epicsDone}/${state.epics.length}`;

    const run = state.run;
    const pill = $('#run-status');
    pill.className = `run-pill ${run ? run.status : ''}`;
    pill.textContent = run ? `${RUN_LABEL[run.status] || run.status}${run.paused && run.status !== 'paused' ? '（一時停止中）' : ''} · ${run.ladder}` : 'デモ';
    pill.title = run ? `統合ブランチ ${run.branch || '—'}\n${run.worktree || ''}\n検証: ${run.checkCommand || '(なし)'}` : '';
    const share = $('#share-url');
    share.hidden = !run?.shareUrl;
    if (run?.shareUrl) {
      share.href = run.shareUrl;
      share.textContent = `🔗 tailnet: ${run.shareUrl.replace(/^\w+:\/\//, '').replace(/\/$/, '')}`;
      share.title = 'tailnet 内の他の端末からはこの URL で開ける（クリックでコピー）';
    }
    if (live) {
      $('#sim-toggle').textContent = run.paused ? '▶ 再開' : '⏸ 一時停止';
      $('#unfreeze').hidden = !run.frozen;
      $('#unhold').hidden = !run.planHold;
      $('#protect-ok').hidden = !run.protectHold;
    }

    // 「いま何をしているか」を 1 行で
    const running = allTasks().filter(({ t }) => t.status === 'running' || t.status === 'critique');
    const reviewing = state.epics.filter((e) => e.status === 'review' && e.review?.verdict === 'pending');
    const bits = [
      ...running.map(({ t }) => `${t.id}${t.activity ? ` › ${t.activity}` : ''}`),
      ...reviewing.map((e) => `${e.id} レビュー中`),
    ];
    $('#now').textContent = bits.length ? `いま: ${bits.join('　|　')}` : run?.status === 'planning' ? 'いま: root が計画を作成中' : '';
  }

  function renderWatchdog(wd) {
    const w = state.watchdog;
    $('#watch-agent').outerHTML = `<span id="watch-agent">${chip(w.agent)}</span>`;
    const pill = $('#watch-status');
    pill.className = `status-pill ${wd.level}`;
    pill.textContent = STATUS_LABEL[wd.level];

    $('#w-tokens').textContent = `${fmtTok(w.usedTokens)} / ${fmtTok(w.budget.tokens)}`;
    $('#w-cost').textContent = `$${w.usedCostUsd.toFixed(1)} / $${w.budget.costUsd}`;
    setMeter('#w-tokens-bar', wd.tokenRatio);
    setMeter('#w-cost-bar', wd.costRatio);
    $('#w-active').textContent = `${wd.active} / ${w.limits.maxActiveAgents}`;
    // トークンと金額のうち、先に尽きるほう（金額はトークンあたりの平均単価で速度を換算）
    const usdPerTok = w.usedTokens > 0 ? w.usedCostUsd / w.usedTokens : 0;
    const costMin = usdPerTok > 0 && wd.burnNow >= 1 ? (w.budget.costUsd - w.usedCostUsd) / (wd.burnNow * usdPerTok) : Infinity;
    const leftMin = Math.min(wd.minutesLeft, costMin);
    if (leftMin <= 0) setStat('#w-eta', '枯渇');
    else if (wd.burnNow < 1) setStat('#w-eta', '—', '消費なし');
    else setStat('#w-eta', `あと ${fmtDur(leftMin)}`, `${mdhm(new Date(now().getTime() + leftMin * 60000))} 頃`, `今の消費速度が続いた場合（${leftMin === costMin ? '金額' : 'トークン'}が先に尽きる）`);
    $('#w-burn').textContent = `現在 ${fmtK(wd.burnNow)}`;
    renderPlan(w.plan);
    $('#w-alerts').innerHTML = wd.alerts.length
      ? wd.alerts.map((a) => `<li class="${a.level}"><span class="ic">${ALERT_ICON[a.level]}</span><span>${esc(a.msg)}</span></li>`).join('')
      : '<li class="ok"><span class="ic">✓</span><span>異常なし</span></li>';
    renderSpark();
  }

  // プランの利用枠。値は run がエージェントを動かしたとき（か定期の確認）に更新される
  function renderPlan(plan) {
    for (const [key, sel] of [['fiveHour', 'plan5'], ['sevenDay', 'plan7']]) {
      const x = plan?.[key];
      $(`#w-${sel}-wrap`).hidden = !x;
      if (!x) continue;
      const reset = x.resetsAt ? new Date(x.resetsAt) : null;
      const pct = `${Math.round(x.utilization * 100)}%`;
      if (!reset) setStat(`#w-${sel}`, pct);
      else if (key === 'fiveHour') setStat(`#w-${sel}`, pct, `${hhmm(reset)} リセット`);
      else setStat(`#w-${sel}`, pct, `リセットまで ${fmtDur((reset - now()) / 60000)}`, `${pct}（${mdhm(reset)} リセット）`);
      setMeter(`#w-${sel}-bar`, x.utilization);
    }
  }

  function setMeter(sel, ratio) {
    const el = $(sel);
    el.style.width = `${Math.min(ratio, 1) * 100}%`;
    el.className = `meter-fill ${ratio >= 0.9 ? 'crit' : ratio >= 0.7 ? 'warn' : ''}`;
  }

  function renderSpark() {
    const { burn, limits } = state.watchdog;
    const W = 300, H = 28;
    const max = Math.max(...burn, limits.burnCritPerMin) * 1.08;
    const x = (i) => (i / (burn.length - 1)) * W;
    const y = (v) => H - (v / max) * H;
    const pts = burn.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    $('#spark').innerHTML = `
      <line class="thr warn" x1="0" x2="${W}" y1="${y(limits.burnWarnPerMin)}" y2="${y(limits.burnWarnPerMin)}"></line>
      <line class="thr crit" x1="0" x2="${W}" y1="${y(limits.burnCritPerMin)}" y2="${y(limits.burnCritPerMin)}"></line>
      <polyline class="line" points="${pts}"></polyline>
      <line class="cross" id="spark-cross" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"></line>`;
  }

  function renderBoard(lockInfo) {
    const heldBy = new Map(lockInfo.held.map((h) => [h.path + '|' + h.taskId, true]));
    const waitsBy = lockInfo.waits.reduce((m, w) => ((m[w.taskId] ||= []).push(w), m), {});
    const doneIds = new Set(state.epics.filter((e) => e.status === 'done').map((e) => e.id));

    for (const col of document.querySelectorAll('.column')) {
      const status = col.dataset.status;
      const epics = state.epics.filter((e) => e.status === status);
      col.querySelector('.count').textContent = epics.length;
      col.querySelector('.cards').innerHTML = epics.map((e) => {
        const done = e.tasks.filter((t) => t.status === 'done').length;
        const pendingDeps = e.dependsOn.filter((d) => !doneIds.has(d));
        const r = e.risk;
        const tasks = e.tasks.map((t) => {
          const files = t.writeSet.map((f) => `<span class="file ${heldBy.has(f + '|' + t.id) ? 'held' : ''}">${esc(f)}</span>`).join('');
          const waits = (waitsBy[t.id] || []).map((w) => `<span class="wait">${esc(w.path)} ← ${esc(w.heldBy)} が保持</span>`).join('');
          const escl = t.attempts.length > 1
            ? `<span class="esc">${t.attempts.map((a) => `<span class="${a.result === 'fail' ? 'fail' : ''}">${esc(a.model)}/${esc(a.effort)}</span>`).join(' → ')}</span>`
            : '';
          const blocked = t.status === 'blocked' ? '<span class="wait">あなたへの依頼待ち</span>' : '';
          const lastCrit = t.critiques?.[t.critiques.length - 1];
          const crit = t.status === 'critique'
            ? `<span class="critic">⚔ 批判的レビュー中 ${chip(t.critic)}</span>`
            : lastCrit && t.status !== 'done' ? `<span class="critic" title="${esc(lastCrit.diagnosis)}">⚔ ${CRITIC_VERDICT[lastCrit.verdict] || esc(lastCrit.verdict)}</span>` : '';
          const la = lastAttempt(t);
          const eta = t.status === 'running' ? taskEta(t) : null;
          const prog = eta && la?.progress?.steps?.length ? `<span class="prog">手順 ${eta.done}/${eta.total}${eta.left != null ? ` · あと約 ${fmtDur(eta.left)}` : ''}</span>` : eta?.left != null ? `<span class="prog">あと約 ${fmtDur(eta.left)}（平均から）</span>` : '';
          const nowText = t.status === 'running' && la?.progress?.now ? la.progress.now : t.activity;
          const act = (t.status === 'running' || t.status === 'critique') && nowText ? `<span class="activity" title="${esc(t.activity || nowText)}">${prog}${esc(nowText)}</span>` : prog ? `<span class="activity">${prog}</span>` : '';
          return `<li class="task ${t.status}">
              <span class="st" title="${t.status}">${TASK_ICON[t.status] || '○'}</span>
              <span class="t-title" title="${esc(t.headline || t.brief || t.title)}">${t.kind ? `<span class="kind" title="${esc(state.kinds?.[t.kind]?.description || t.kind)}">${esc(t.kind)}</span>` : ''}${esc(t.id)} ${esc(t.title)}</span>
              <span class="t-sub">${chip(t.agent)}${files}${waits}${blocked}${escl}${crit}</span>
              ${act}
            </li>`;
        }).join('');
        const cls = [pendingDeps.length && 'blocked-deps', e.tasks.some((t) => t.status === 'failed') && 'has-failed', e.tasks.some((t) => t.status === 'blocked') && 'has-blocked'].filter(Boolean).join(' ');
        return `<article class="card ${cls}" data-epic="${esc(e.id)}">
            <div class="card-head"><span class="card-id">${esc(e.id)}</span><span class="card-title">${esc(e.title)}</span></div>
            ${e.brief ? `<div class="card-brief">${esc(e.brief)}</div>` : ''}
            <div class="card-meta">
              <span>リード</span>${chip(e.lead)}
              <span class="risk" title="complexity / uncertainty / blast radius">
                <span>C<i style="--v:${r.complexity * 100}%"></i></span>
                <span>U<i style="--v:${r.uncertainty * 100}%"></i></span>
                <span>B<i style="--v:${r.blast * 100}%"></i></span>
              </span>
              ${pendingDeps.length ? `<span>依存待ち: ${esc(pendingDeps.join(', '))}</span>` : ''}
              ${(() => { const x = epicEta(e); return x?.left != null ? `<span class="eta" title="完了した task の平均 ${x.avg != null ? fmtDur(x.avg) : '—'} と、実行中の task の手順の進みからの目安">残り約 ${fmtDur(x.left)}</span>` : ''; })()}
            </div>
            <div class="meter"><div class="meter-fill" style="width:${(done / e.tasks.length) * 100}%"></div></div>
            ${e.review ? `<div class="review-note">レビュー ${chip(e.review.reviewer)} ${esc(e.review.note)}</div>` : ''}
            <ul class="tasks">${tasks}</ul>
          </article>`;
      }).join('') || '<p class="empty">—</p>';
    }
  }

  // 依頼パネル: 入力中の返答が消えないよう、依頼に変化があったときだけ描き直す
  let reqKey = '';
  function renderRequests() {
    const reqs = state.requests || [];
    const key = JSON.stringify(reqs) + live;
    const openReqs = reqs.filter((r) => r.status === 'open').sort((a, b) => b.blocking - a.blocking);
    $('#req-count').textContent = openReqs.length ? `${openReqs.length} 件未対応` : '';
    if (key === reqKey) return;
    reqKey = key;

    const box = $('#requests');
    const drafts = {};
    box.querySelectorAll('input[data-req]').forEach((i) => { drafts[i.dataset.req] = i.value; });
    const focused = document.activeElement?.dataset?.req;

    const item = (r) => {
      const where = [r.taskId || r.epicId || 'プロジェクト全体', r.from && `from ${r.from}`, r.createdAt && hhmm(new Date(r.createdAt))].filter(Boolean).join(' · ');
      const actions = r.status === 'open'
        ? `<div class="req-reply">
            <input data-req="${esc(r.id)}" placeholder="返答（任意）: 例「設定済み」「MIT で」" aria-label="${esc(r.id)} への返答">
            <button class="btn" data-resolve="${esc(r.id)}" ${live ? '' : 'disabled title="ライブ接続時のみ"'}>対応済み</button>
            <button class="btn ghost" data-dismiss="${esc(r.id)}" ${live ? '' : 'disabled'}>却下</button>
          </div>`
        : `<div class="req-answer">${r.status === 'dismissed' ? '却下' : '対応済み'}${r.reply ? `: ${esc(r.reply)}` : ''}</div>`;
      return `<div class="req ${r.blocking && r.status === 'open' ? 'blocking' : ''} ${r.status !== 'open' ? 'closed' : ''}">
          <div class="req-head"><span class="req-kind">${REQ_KIND[r.kind] || esc(r.kind)}</span><span class="req-title">${esc(r.title)}</span></div>
          <div class="req-meta">${esc(r.id)} · ${esc(where)}${r.blocking ? ' · <b>この task は停止中</b>' : ''}</div>
          <div class="req-detail">${richText(r.detail)}</div>
          ${actions}
        </div>`;
    };
    const closed = reqs.filter((r) => r.status !== 'open').reverse();
    box.innerHTML = (openReqs.length ? openReqs.map(item).join('') : '<p class="empty">いまお願いしたいことはありません</p>') +
      (closed.length ? `<p class="req-section">対応済み ${closed.length} 件</p>${closed.map(item).join('')}` : '');

    box.querySelectorAll('input[data-req]').forEach((i) => {
      if (drafts[i.dataset.req]) i.value = drafts[i.dataset.req];
      if (i.dataset.req === focused) i.focus();
    });
  }

  function renderLocks(lockInfo) {
    const rows = lockInfo.held.map((h) => {
      const waiting = lockInfo.waits.filter((w) => w.heldPath === h.path && w.heldBy === h.taskId).map((w) => `${esc(w.taskId)} (${esc(w.path)})`);
      return `<tr><td><span class="file held">${esc(h.path)}</span></td><td>${esc(h.taskId)} <span class="muted">${h.status}</span></td><td>${chip(h.agent)}</td><td>${waiting.join('<br>') || '<span class="muted">—</span>'}</td></tr>`;
    });
    $('#locks-body').innerHTML = rows.join('') || '<tr><td colspan="4" class="muted">ロックなし</td></tr>';
  }

  function renderEvents() {
    $('#events').innerHTML = state.events.slice().reverse().map((e) =>
      `<li><span class="t">${esc(e.t)}</span><span class="k">${esc(e.kind)}</span><span>${esc(e.msg)}</span></li>`).join('');
  }

  // ---------- 詳細ダイアログ ----------
  function openDetail(epicId, refresh = false) {
    const e = state.epics.find((x) => x.id === epicId);
    if (!e) return;
    openEpic = epicId;
    const r = route(e.risk);
    const rows = e.tasks.map((t) => `<tr>
        <td>${esc(t.id)}${t.kind ? `<br><span class="kind">${esc(t.kind)}</span>` : ''}</td>
        <td><b>${esc(t.title)}</b>${t.brief ? `<div class="brief">${esc(t.brief)}</div>` : ''}
          ${t.headline ? `<div class="headline">→ ${esc(t.headline)}</div>` : ''}
          ${t.needs?.length ? `<div class="muted">前提: ${esc(t.needs.join(', '))}</div>` : ''}
          ${t.description || t.summary || t.grants?.length ? `<details><summary>エージェント向けの詳細</summary>
            ${t.description ? `<div class="desc"><b>やること:</b> ${esc(t.description)}</div>` : ''}
            ${t.summary ? `<div class="desc"><b>結果:</b> ${esc(t.summary)}</div>` : ''}
            ${t.grants?.length ? `<div class="desc">追加で許可: ${esc(t.grants.join(', '))}</div>` : ''}</details>` : ''}</td>
        <td>${t.status}${t.status === 'failed' && live ? `<br><button class="btn" data-retry="${esc(t.id)}">再試行</button>` : ''}</td><td>${chip(t.agent)}</td>
        <td>${t.writeSet.map((f) => `<span class="file">${esc(f)}</span>`).join(' ') || '<span class="muted">読み取りのみ</span>'}</td>
        <td>${t.attempts.map((a, i) => `<div class="att">#${i + 1} <b>${RESULT_LABEL[a.result] || esc(a.result)}</b> <span class="muted">${esc(a.model)}/${esc(a.effort)} · ${a.result === 'running' ? `経過 ${fmtDur(minsSince(a.startedAt))}${(() => { const x = taskEta(t); return x?.left != null ? ` · あと約 ${fmtDur(x.left)}（${x.basis}から）` : ''; })()}` : a.endedAt ? fmtDur((new Date(a.endedAt) - new Date(a.startedAt)) / 60000) : ''}</span>${a.result === 'running' ? progressBlock(a) : a.progress?.steps?.length ? `<details><summary>手順 ${a.progress.steps.filter((x) => x.done).length}/${a.progress.steps.length}</summary>${progressBlock(a)}</details>` : ''}${a.headline ? ` — ${esc(a.headline)}` : ''}${a.note ? `<details><summary>${esc(oneLine(a.note, 70))}</summary><div class="desc">${esc(a.note)}</div></details>` : ''}</div>`).join('') || '—'}
          ${(t.critiques || []).map((c) => `<div class="critique"><b>⚔ critic ${esc(c.model)}/${esc(c.effort)} → ${CRITIC_VERDICT[c.verdict] || esc(c.verdict)}</b>
            <div>${esc(c.diagnosis)}</div>
            ${c.flawedAssumptions?.length ? `<div class="muted">誤った前提: ${esc(c.flawedAssumptions.join(' / '))}</div>` : ''}
            ${c.unansweredQuestions?.length ? `<div class="muted">未解決の問い: ${esc(c.unansweredQuestions.join(' / '))}</div>` : ''}
            <div>指示: ${esc(c.guidance)}</div></div>`).join('')}</td>
        <td style="text-align:right">${fmtTok(t.tokens)}${t.costUsd ? `<br><span class="muted">$${t.costUsd.toFixed(2)}</span>` : ''}</td></tr>`).join('');
    const needsHuman = e.review?.verdict === 'needs-human';
    $('#detail-body').innerHTML = `
      <span class="eyebrow">${esc(e.id)} · ${e.status}</span>
      <h3>${esc(e.title)}</h3>
      ${e.brief ? `<p class="brief">${esc(e.brief)}</p>` : ''}
      ${(() => { const d = e.tasks.filter((t) => t.status === 'done').length; const x = epicEta(e);
        return `<p class="epic-progress">task 完了 ${d}/${e.tasks.length}${x ? `・実行中 ${x.running}・未着手 ${x.todo}${x.left != null ? `・残り約 ${fmtDur(x.left)}` : ''}` : ''}${x?.avg != null ? `<span class="muted">（完了した task の平均 ${fmtDur(x.avg)}。実行中は手順の進みから）</span>` : ''}</p>`; })()}
      <p class="muted">リスク score = 0.5·C + 0.3·U + 0.2·B = <b>${riskScore(e.risk).toFixed(2)}</b>
        → 初期ルーティング <b>${r.model}/${r.effort}</b>（失敗ごとに 1 段昇格）。依存: ${esc(e.dependsOn.join(', ')) || 'なし'}</p>
      ${e.review ? `<p class="desc">レビュー: ${esc(e.review.note)}</p>` : e.lastReviewNote ? `<p class="desc">前回レビュー: ${esc(e.lastReviewNote)}</p>` : ''}
      ${needsHuman && live ? `<div class="actions"><button class="btn" data-approve="${esc(e.id)}">人間判断で承認して完了にする</button></div>` : ''}
      <table class="task-table"><colgroup><col class="c-id"><col class="c-task"><col class="c-st"><col class="c-agent"><col class="c-ws"><col class="c-att"><col class="c-tok"></colgroup>
        <thead><tr><th>ID</th><th>タスク</th><th>状態</th><th>担当</th><th>writeSet</th><th>試行履歴</th><th>tokens</th></tr></thead><tbody>${rows}</tbody></table>`;
    if (!refresh) $('#detail').showModal();
  }

  // ---------- デモ用シミュレーション（オーケストレータの代役） ----------
  const PER_MIN = { opus: 9000, sonnet: 6000, codex: 7000, haiku: 2500 };
  const USD_PER_MTOK = { opus: 25, sonnet: 10, codex: 10, haiku: 3 };
  let agentSeq = 100;

  function log(kind, msg) { state.events.push({ t: hhmm(simClock), kind, msg }); }

  function spawn(role, { model, effort }) {
    const id = `${role === 'lead' ? 'lead' : 'w'}-${++agentSeq}`;
    state.agents[id] = { role, model, effort, state: 'active' };
    return id;
  }

  function tick() {
    simClock = new Date(simClock.getTime() + 60000);
    const w = state.watchdog;
    let burn = 0, cost = 0;

    for (const e of state.epics) {
      if (e.status === 'todo' && e.dependsOn.every((d) => state.epics.find((x) => x.id === d).status === 'done')) {
        e.status = 'running';
        e.lead = spawn('lead', route(e.risk));
        log('start', `${e.id} 開始。リード ${state.agents[e.lead].model}/${state.agents[e.lead].effort}`);
      }
      if (e.status !== 'running') continue;

      for (const t of e.tasks) {
        if (t.status === 'running') {
          const a = state.agents[t.agent];
          const used = Math.round(PER_MIN[a.model] * (0.6 + Math.random() * 0.8));
          t.tokens += used; burn += used; cost += (used / 1e6) * USD_PER_MTOK[a.model];
          if (Math.random() < 0.12) {
            const attempt = t.attempts[t.attempts.length - 1];
            if (Math.random() < 0.25) {
              attempt.result = 'fail';
              const next = escalate(attempt);
              a.model = next.model; a.effort = next.effort;
              t.attempts.push({ ...next, result: 'running' });
              log('escalate', `${t.id}: ${attempt.model}/${attempt.effort} 失敗 → ${next.model}/${next.effort} に昇格`);
            } else {
              attempt.result = 'ok'; t.status = 'done'; a.state = 'finished';
              log('done', `${t.id} 完了。ロック ${t.writeSet.join(', ') || '(なし)'} を解放`);
            }
          }
        } else if (t.status === 'todo') {
          if (!t.agent) t.agent = spawn('worker', route(e.risk));
          if (locks.canAcquire(state, t)) {
            const a = state.agents[t.agent];
            t.status = 'running'; a.state = 'active';
            t.attempts.push({ model: a.model, effort: a.effort, result: 'running' });
            log('lock', `${t.id} がロック取得: ${t.writeSet.join(', ') || '(なし)'}`);
          } else {
            state.agents[t.agent].state = 'waiting';
          }
        }
      }

      if (e.tasks.every((t) => t.status === 'done')) {
        e.status = 'review';
        e.review = { reviewer: 'rev-1', verdict: 'pending', note: 'テスト・静的解析・差分レビュー中' };
        log('review', `${e.id} をレビューへ`);
      }
    }

    // レビュー: 承認 or 差し戻し（差し戻しは修正 task を追加して running に戻す = 閉ループ）
    for (const e of state.epics.filter((x) => x.status === 'review')) {
      burn += 3000; cost += 0.075;
      if (Math.random() > 0.15) continue;
      if (Math.random() < 0.25 && !e.tasks.some((t) => t.id.endsWith('-FIX'))) {
        const files = [...new Set(e.tasks.flatMap((t) => t.writeSet))].slice(0, 1);
        e.tasks.push({ id: `${e.id}-FIX`, title: 'レビュー指摘の修正', status: 'todo', agent: null, writeSet: files, tokens: 0, attempts: [] });
        e.tasks.forEach((t) => { if (t.status === 'review') t.status = 'done'; });
        e.status = 'running'; e.review = null;
        log('reject', `${e.id} 差し戻し。修正 task を追加して再計画`);
      } else {
        e.tasks.forEach((t) => { if (t.status === 'review') t.status = 'done'; });
        e.status = 'done'; e.review = null;
        if (e.lead) state.agents[e.lead].state = 'finished';
        log('accept', `${e.id} 承認 → 完了`);
      }
    }

    burn += 800;
    w.burn.push(burn); w.burn.shift();
    w.usedTokens += burn; w.usedCostUsd += cost;

    const wd = render();
    const budgetRatio = Math.max(w.usedTokens / w.budget.tokens, w.usedCostUsd / w.budget.costUsd);
    if (budgetRatio >= 0.9) {
      log('watchdog', '予算 90% 超過。監視役が新規 spawn を停止しました');
      stopSim(); render();
    } else if (state.epics.every((e) => e.status === 'done')) {
      log('done', 'プロジェクト完了'); stopSim(); render();
    }
    return wd;
  }

  function startSim() { simTimer = setInterval(tick, 1200); $('#sim-toggle').textContent = '⏸ 停止'; }
  function stopSim() { clearInterval(simTimer); simTimer = null; $('#sim-toggle').textContent = '▶ シミュレーション'; }

  // ---------- ライブ接続 ----------
  async function connectLive() {
    if (location.protocol === 'file:') return false;
    try {
      const r = await fetch('api/state', { cache: 'no-store' });
      if (!r.ok) return false;
      state = await r.json();
    } catch { return false; }
    live = true;
    document.title = 'Agent Team Viewer · live';
    const src = new EventSource('api/events');
    let rafPending = false;
    src.onmessage = (ev) => {
      state = JSON.parse(ev.data);
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; render(); });
    };
    src.onerror = () => { $('#run-status').textContent = '接続が切れました（再接続中…）'; };
    render();
    return true;
  }

  // ---------- イベント配線 ----------
  $('#sim-toggle').addEventListener('click', () => {
    if (live) return post('api/control', { action: state.run.paused ? 'resume' : 'pause' });
    simTimer ? stopSim() : startSim();
  });
  // 監視役のパネル: クリックで拡大 / 縮小（ボタンやリンクのクリックは除く）
  const watchEl = $('#watch');
  const setExpanded = (on) => {
    watchEl.classList.toggle('expanded', on);
    document.querySelector('.watch-backdrop')?.remove();
    if (on) {
      const bd = document.createElement('div');
      bd.className = 'watch-backdrop';
      bd.addEventListener('click', () => setExpanded(false));
      document.body.appendChild(bd);
    }
  };
  watchEl.addEventListener('click', (ev) => { if (!ev.target.closest('button, a, input')) setExpanded(!watchEl.classList.contains('expanded')); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') setExpanded(false); });
  $('#restart').addEventListener('click', () => {
    if (!live) return;
    if (confirm('最新版のコードで、設定と状態を引き継いで再起動します。\n実行中のエージェントが終わるのを待ってから再起動しますか？\n（キャンセルすると「今すぐ中断して再起動」を選べます）')) post('api/control', { action: 'restart', mode: 'drain' });
    else if (confirm('実行中のエージェントを中断して、今すぐ再起動しますか？（中断した task は次の起動で最初からやり直します）')) post('api/control', { action: 'restart', mode: 'now' });
  });
  $('#protect-ok').addEventListener('click', () => {
    if (confirm('保護パスの変更を確認しました（エージェントの書き込みは元に戻した / 自分の編集だった）。今の状態を新しい基準にして再開します。よろしいですか？')) post('api/control', { action: 'protect-ok' });
  });
  $('#unhold').addEventListener('click', () => {
    if (confirm('利用枠のリセットを待たずに再開します（この枠がリセットされるまで再停止しません）。よろしいですか？')) post('api/control', { action: 'unhold' });
  });
  $('#unfreeze').addEventListener('click', () => {
    if (confirm('予算を 1.5 倍に広げて再開します。よろしいですか？')) post('api/control', { action: 'unfreeze' });
  });
  $('#share-url').addEventListener('click', (ev) => {
    if (!navigator.clipboard) return;
    ev.preventDefault();
    navigator.clipboard.writeText(state.run.shareUrl).then(() => { ev.target.textContent = '✓ URL をコピーしました'; });
  });
  $('#theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
  });
  $('#board').addEventListener('click', (ev) => {
    const card = ev.target.closest('.card');
    if (card) openDetail(card.dataset.epic);
  });
  $('#detail').addEventListener('close', () => { openEpic = null; });
  $('#detail').addEventListener('click', (ev) => {
    const retry = ev.target.closest('[data-retry]');
    const approve = ev.target.closest('[data-approve]');
    if (retry) post('api/control', { action: 'retry', taskId: retry.dataset.retry });
    if (approve) post('api/control', { action: 'approve', epicId: approve.dataset.approve });
  });
  $('#requests').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-resolve],[data-dismiss]');
    if (!b || !live) return;
    const id = b.dataset.resolve || b.dataset.dismiss;
    const reply = $(`#requests input[data-req="${CSS.escape(id)}"]`)?.value || '';
    post(`api/requests/${encodeURIComponent(id)}`, { reply, dismiss: Boolean(b.dataset.dismiss) });
  });
  $('#requests').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.dataset.req && !ev.isComposing) $(`#requests [data-resolve="${CSS.escape(ev.target.dataset.req)}"]`)?.click();
  });

  const spark = $('#spark'), tip = $('#spark-tip');
  spark.addEventListener('mousemove', (ev) => {
    const burn = state.watchdog.burn;
    const rect = spark.getBoundingClientRect();
    const i = Math.round(((ev.clientX - rect.left) / rect.width) * (burn.length - 1));
    const cross = $('#spark-cross');
    const x = (i / (burn.length - 1)) * 300;
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
    const ago = burn.length - 1 - i;
    tip.hidden = false;
    tip.textContent = `${ago ? `${ago}分前` : '現在'}: ${fmtK(burn[i])} tok/min`;
    tip.style.left = `${Math.min((i / (burn.length - 1)) * rect.width, rect.width - 110)}px`;
  });
  spark.addEventListener('mouseleave', () => { tip.hidden = true; $('#spark-cross')?.setAttribute('visibility', 'hidden'); });

  connectLive().then((ok) => {
    if (ok) return;
    render();
    if (new URLSearchParams(location.search).has('autoplay')) startSim();
    if (new URLSearchParams(location.search).has('watch')) setExpanded(true);
    const ep = new URLSearchParams(location.search).get('epic');
    if (ep) openDetail(ep);
  });
  window.addEventListener('error', (e) => { document.title = 'ERR: ' + e.message; });
})();
