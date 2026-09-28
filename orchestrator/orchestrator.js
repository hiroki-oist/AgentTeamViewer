// 閉ループのオーケストレータ。
//   計画(root) → epic ごとに task を並列実行（ロック・同時数・予算の範囲で）
//   → task ごとに 検証(writeSet / checkCommand) → 統合ブランチへマージ
//   → 失敗なら梯子を 1 段上げて再試行 → epic の task が揃ったらレビュー
//   → 差し戻しなら修正 task を足して再実行 → 全 epic 承認で完了
// 状態は常に 1 つの JSON（ボードのスキーマ）で持ち、変化のたびに 'change' を emit する。
const { EventEmitter } = require('node:events');
const { exec } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('../js/policy.js');
const locks = require('../js/locks.js');
const watchdog = require('../js/watchdog.js');
const runners = require('./runners.js');
const { Repo, covered } = require('./git.js');
const { SCHEMAS, prompts } = require('./prompts.js');
const { Kinds, GUARD, NO_AUTO_GRANT, guarded } = require('./kinds.js');
const { Protector } = require('./protect.js');

const hhmm = (d = new Date()) => d.toTimeString().slice(0, 5);
const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));
const normPath = (p) => String(p).trim().replace(/^\.?\/+/, '');

class Orchestrator extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ladder = policy.LADDERS[cfg.ladder];
    if (!this.ladder) throw new Error(`未知の ladder: ${cfg.ladder}（${Object.keys(policy.LADDERS).join(' / ')}）`);
    this.runId = cfg.runId || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    this.controllers = new Set();
    this.inflight = new Set(); // 後片付け待ちの task 試行
    this.agentSeq = 0;
    this.reqSeq = 0;
    this.state = {
      run: { id: this.runId, status: 'starting', paused: Boolean(cfg.startPaused), frozen: false, ladder: cfg.ladder, repo: path.resolve(cfg.repo), branch: null, checkCommand: cfg.check || '', startedAt: new Date().toISOString() },
      project: { id: `RUN-${this.runId}`, name: '計画中…', goal: cfg.goal, successCriteria: [] },
      epics: [],
      agents: { watchdog: { role: 'watchdog', model: 'rules', effort: 'low', state: 'active' } },
      requests: [],
      watchdog: {
        agent: 'watchdog',
        budget: { tokens: cfg.budgetTokens, costUsd: cfg.budgetUsd },
        limits: { maxActiveAgents: cfg.maxAgents, maxAttemptsPerTask: cfg.maxAttempts, burnWarnPerMin: cfg.burnWarn, burnCritPerMin: cfg.burnCrit,
          planWeekWarn: cfg.planWeekWarn, planWeekStop: cfg.planWeekStop, planFiveHourStop: cfg.planFiveHourStop, planWeekShare: cfg.planWeekShare },
        // プランの利用枠（claude の rate_limit_event から）。{ fiveHour, sevenDay: { utilization, resetsAt }, at, weekStart }
        plan: null,
        burn: Array(30).fill(0),
        usedTokens: 0,
        usedCostUsd: 0,
      },
      events: [],
    };
  }

  // ---------- 状態の小物 ----------
  changed() { this.emit('change', this.state); }

  log(kind, msg) {
    this.state.events.push({ t: hhmm(), kind, msg });
    if (this.state.events.length > 500) this.state.events.splice(0, this.state.events.length - 500);
    console.log(`[${hhmm()}] ${kind.padEnd(8)} ${msg}`);
    this.changed();
  }

  newAgent(role, route) {
    const id = `${{ worker: 'w', reviewer: 'rev' }[role] || role}-${++this.agentSeq}`;
    this.state.agents[id] = { role, runner: route.runner, model: route.model, effort: route.effort, state: 'waiting' };
    return id;
  }

  addUsage(tokens, costUsd) {
    const w = this.state.watchdog;
    w.usedTokens += tokens;
    w.usedCostUsd += costUsd;
    w.burn[w.burn.length - 1] += tokens;
  }

  // ---------- プランの利用枠 ----------
  usesClaude() { return this.ladder.some((r) => r.runner === 'claude'); }

  updatePlan(info) {
    const win = info?.unifiedWindows;
    if (!win) return;
    const w = this.state.watchdog;
    const norm = (x) => x && { utilization: Number(x.utilization) || 0, resetsAt: x.resetsAt ? new Date(x.resetsAt * 1000).toISOString() : null };
    const prev = w.plan;
    const sevenDay = norm(win.seven_day);
    // 週の枠がリセットされたら（または最初の観測なら）、この run の起点を取り直す
    const weekStart = !prev?.sevenDay || !sevenDay || prev.sevenDay.resetsAt !== sevenDay.resetsAt ? sevenDay?.utilization ?? 0 : prev.weekStart;
    w.plan = { fiveHour: norm(win.five_hour), sevenDay, status: info.status, at: new Date().toISOString(), weekStart };
    this.lastPlanAt = Date.now();
    // 窓は増えることがある（Fable を使うと seven_day_overage_included が出る）。全部そのまま残す
    w.planWindows = Object.fromEntries(Object.entries(win).map(([k, x]) => [k, { utilization: Number(x?.utilization) || 0, resetsAt: x?.resetsAt ? new Date(x.resetsAt * 1000).toISOString() : null }]));
    if (info.probeCostUsd) w.probeCostUsd = (w.probeCostUsd || 0) + info.probeCostUsd;
    this.checkPlan();
    this.changed();
  }

  // 枠の使用率がしきい値を超えたら新規 spawn を止め、リセット時刻に自動で再開する
  checkPlan() {
    const run = this.state.run;
    const w = this.state.watchdog;
    const p = w.plan, L = w.limits;
    if (!p) return;
    const pct = (x) => `${Math.round(x * 100)}%`;
    const at = (iso) => (iso ? new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '?');
    if (run.planHold && Date.now() >= Date.parse(run.planHold.until)) {
      this.log('watchdog', `利用枠のリセット時刻 (${at(run.planHold.until)}) を過ぎたので再開`);
      run.planHold = null;
      this.probePlanSoon(0);
    }
    const f = p.fiveHour, d = p.sevenDay;
    const weekUsedByRun = d ? d.utilization - (p.weekStart ?? d.utilization) : 0;
    let hold = null;
    if (d && L.planWeekStop > 0 && d.utilization >= L.planWeekStop) hold = { reason: `週の枠が ${pct(d.utilization)}（停止 ${pct(L.planWeekStop)}）`, until: d.resetsAt, window: 'seven_day' };
    else if (d && L.planWeekShare > 0 && weekUsedByRun >= L.planWeekShare) hold = { reason: `この run で週の枠を ${pct(weekUsedByRun)} 使用（上限 ${pct(L.planWeekShare)}）`, until: d.resetsAt, window: 'run_share' };
    else if (f && L.planFiveHourStop > 0 && f.utilization >= L.planFiveHourStop) hold = { reason: `5 時間枠が ${pct(f.utilization)}（停止 ${pct(L.planFiveHourStop)}）`, until: f.resetsAt, window: 'five_hour' };
    else if (p.status === 'rejected') hold = { reason: '利用枠の上限に到達', until: (f?.utilization >= (d?.utilization ?? 0) ? f : d)?.resetsAt, window: 'rejected' };
    // 人間が「この枠は無視して続ける」と決めた窓は、リセットまで止めない
    if (hold && run.planOverride && run.planOverride.window === hold.window && run.planOverride.until === hold.until) hold = null;
    if (hold && !run.planHold && hold.until) {
      run.planHold = hold;
      this.log('watchdog', `${hold.reason}。新規 spawn を止め、${at(hold.until)} に自動で再開（実行中の agent は最後まで走らせる）`);
      this.addRequests([{ kind: 'decision', blocking: false, title: `利用枠で一時停止中（${at(hold.until)} まで）`,
        detail: `${hold.reason}。リセットを待たずに続けるなら、ボードの「枠を無視して続ける」か {"action":"unhold"} を送ってください。` }], { from: 'watchdog' });
    }
    if (d && L.planWeekWarn > 0 && d.utilization >= L.planWeekWarn && this.warnedWeek !== d.resetsAt) {
      this.warnedWeek = d.resetsAt;
      this.log('watchdog', `週の枠が ${pct(d.utilization)} に到達（警告 ${pct(L.planWeekWarn)}、${at(d.resetsAt)} にリセット）`);
    }
  }

  // エージェントが動いていないと枠の値が更新されないので、ときどき自分で確かめる
  probePlanSoon(delayMs) {
    if (!this.usesClaude() || this.probing || this.shuttingDown) return;
    clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(async () => {
      this.probing = true;
      try { this.updatePlan(await runners.probeRateLimit(this.cfg)); } catch { /* 次の機会に */ }
      this.probing = false;
    }, delayMs);
  }

  // 保護パスに起動時（か人間の了承時）からの変化があれば、新規 spawn を止めて知らせる
  async checkProtected() {
    if (this.checkingProtected || this.state.run.protectHold || this.shuttingDown) return;
    this.checkingProtected = true;
    try {
      const changed = await this.protector.changes();
      if (!changed.length) return;
      const running = this.state.epics.flatMap((e) => e.tasks).filter((t) => t.status === 'running').map((t) => t.id);
      this.state.run.protectHold = { paths: changed.slice(0, 50), tasks: running, at: new Date().toISOString() };
      this.log('watchdog', `保護パスが変更された: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` ほか ${changed.length - 5} 件` : ''}（その時動いていた task: ${running.join(', ') || 'なし'}）。新規 spawn を停止`);
      this.addRequests([{ kind: 'decision', blocking: false, title: '保護パス（元の作業ツリーなど）が変更された',
        detail: `変更されたパス:\n${changed.slice(0, 20).join('\n')}\n\nその時動いていた task: ${running.join(', ') || 'なし'}。エージェントの書き込みなら中身を確かめて元に戻し、あなた自身の編集ならそのままで構いません。済んだらボードの「保護パスを確認した」か {"action":"protect-ok"} を送ると、今の状態を新しい基準にして再開します。` }], { from: 'watchdog' });
      this.schedule();
    } finally { this.checkingProtected = false; }
  }

  activeCount() {
    return Object.values(this.state.agents).filter((a) => a.state === 'active' && a.role !== 'watchdog').length;
  }

  // ---------- 起動 ----------
  async start() {
    this.repo = new Repo(this.cfg.repo, this.runId);
    const { dirty } = await this.repo.prepare();
    this.state.run.branch = this.repo.mainBranch;
    this.state.run.worktree = this.repo.mainPath;
    this.statePath = path.join(this.repo.dir, 'state.json');
    this.on('change', () => this.persistSoon());
    if (dirty) this.log('warn', '元の作業ツリーに未コミットの変更あり。統合ブランチは HEAD から切るので、それらは含まれない');
    this.log('start', `統合ブランチ ${this.repo.mainBranch} を作成（${this.repo.mainPath}）`);
    this.kinds = new Kinds({ repoRoot: this.repo.root, runDir: this.repo.dir, available: this.cfg.available || { claude: true, codex: false } });
    this.state.kinds = this.kinds.summary();

    // 元の作業ツリー（と --protect のパス）への書き込みを塞ぐ。runner は cfg.protector で包む
    const gitDir = path.resolve(this.repo.root, (await require('./git.js').git(this.repo.root, ['rev-parse', '--git-common-dir'])).out);
    this.protector = new Protector({ paths: [this.repo.root, ...(this.cfg.protect || [])], gitDir, bwrap: this.cfg.bwrap, ignore: ['.atv/'] });
    this.cfg.protector = this.protector;
    await this.protector.rebaseline();
    this.state.run.protect = { mode: this.protector.mode, paths: this.protector.paths };
    this.log('start', this.protector.mode === 'bwrap'
      ? `保護パスを読み取り専用にしてエージェントを動かす（bwrap）: ${this.protector.paths.join(', ')}`
      : `bwrap が使えないため、保護パスの変化を監視する（見つけたら新規 spawn を停止）: ${this.protector.paths.join(', ')}`);
    this.protectTimer = setInterval(() => this.checkProtected(), 5000);
    if (this.cfg.inspectMin > 0) this.inspectTimer = setInterval(() => this.inspectSoon('定期'), this.cfg.inspectMin * 60000);

    // 1 分ごとに累計を記録する（予算枯渇の予測は直近 1 時間の実際の増え方から出す。24 時間ぶん持つ）
    const record = () => {
      const w = this.state.watchdog;
      (w.history ||= []).push({ t: new Date().toISOString(), tok: w.usedTokens, usd: Math.round(w.usedCostUsd * 1e4) / 1e4 });
      if (w.history.length > 1440) w.history.splice(0, w.history.length - 1440);
    };
    record();
    this.minuteTimer = setInterval(() => { const b = this.state.watchdog.burn; b.push(0); b.shift(); record(); this.changed(); }, 60000);
    this.tickTimer = setInterval(() => this.schedule(), 1000);
    this.planTimer = setInterval(() => {
      if (Date.now() - (this.lastPlanAt || 0) >= this.cfg.planProbeMin * 60000) this.probePlanSoon(0);
    }, 60000);
    this.probePlanSoon(0);

    if (this.cfg.resume && fs.existsSync(this.statePath)) {
      this.restore(JSON.parse(fs.readFileSync(this.statePath, 'utf8')));
      await this.inferNeeds();
      await this.inferBriefs();
    } else await this.plan();
    this.schedule();
  }

  // 前の run の state.json から続きを始める（計画・task の状態・依頼・使用量を引き継ぐ）。
  // 実行中だったものは中断扱いで todo に戻し、レビュー中だった epic はレビューし直す
  restore(prev) {
    const s = this.state;
    s.project = prev.project;
    s.requests = prev.requests || [];
    s.events = [...(prev.events || []), { t: hhmm(), kind: 'start', msg: '--resume: 前の状態から再開' }];
    s.run.startedAt = prev.run?.startedAt || s.run.startedAt;
    s.run.checkCommand = this.cfg.check || prev.run?.checkCommand || '';
    // 予算・上限は今回の指定を使い、使用量と利用枠の起点は引き継ぐ
    const w = s.watchdog, pw = prev.watchdog || {};
    w.usedTokens = pw.usedTokens || 0;
    w.usedCostUsd = pw.usedCostUsd || 0;
    w.plan = pw.plan || null;
    w.byModel = pw.byModel || {};
    w.history = pw.history || [];
    w.probeCostUsd = pw.probeCostUsd || 0;
    const known = new Set(Object.keys(prev.agents || {}));
    s.agents = { ...s.agents, ...Object.fromEntries(Object.entries(prev.agents || {}).filter(([k]) => k !== 'watchdog').map(([k, a]) => [k, { ...a, state: a.state === 'active' ? 'waiting' : a.state, activity: null }])) };
    this.agentSeq = Math.max(0, ...[...known].map((k) => Number(k.split('-').pop()) || 0));
    this.reqSeq = Math.max(0, ...s.requests.map((r) => Number(String(r.id).replace(/^R/, '')) || 0));
    this.rootAgent = Object.keys(s.agents).find((k) => s.agents[k].role === 'lead');
    const openBlock = (t) => s.requests.some((r) => r.blocking && r.status === 'open' && (r.taskIds || [r.taskId]).includes(t.id));
    s.epics = (prev.epics || []).map((e) => {
      if (e.status === 'review') { e.status = 'running'; e.review = null; }
      e.tasks = e.tasks.map((t) => {
        const n = { ...this.newTask(t, e), ...t, kind: this.kindName(t.kind), grants: t.grants || [], activity: null };
        for (const a of n.attempts) if (a.result === 'running') { a.result = 'interrupted'; a.note = 'オーケストレータの再起動で中断'; }
        // 状態を保存する前に止まっていても、中断した試行のブランチが残っていれば持ち込む
        if (!n.carryBranch && n.status !== 'done' && n.attempts.length) {
          // 新しい試行から順にさかのぼり、残っているブランチを探す（途中で止まった試行はブランチを残さないことがある）
          for (let k = n.attempts.length; k >= 1 && !n.carryBranch; k--) {
            const b = `atv/${this.runId}/task/${n.id}-a${k}`;
            try { require('node:child_process').execFileSync('git', ['-C', this.repo.root, 'rev-parse', '--verify', '-q', b], { stdio: 'ignore' }); n.carryBranch = b; } catch { /* ない */ }
          }
        }
        if (['running', 'critique', 'review'].includes(n.status)) n.status = n.status === 'review' ? 'done' : 'todo';
        // 依頼なしで止まっていた task（旧版のバグ）は、そのまま続けさせる
        if (n.status === 'blocked' && !openBlock(n)) { n.status = 'todo'; this.log('start', `${n.id}: 依頼なしで止まっていたので再開`); }
        return n;
      });
      return e;
    });
    this.fallbackKind = {};
    const n = s.epics.reduce((a, e) => a + e.tasks.length, 0), done = s.epics.reduce((a, e) => a + e.tasks.filter((t) => t.status === 'done').length, 0);
    s.run.status = 'running';
    this.log('start', `前の状態から再開: 中プロジェクト ${s.epics.length} 件 / task ${n} 件（完了 ${done} 件）。使用量 ${w.usedTokens} tok / $${w.usedCostUsd.toFixed(2)} を引き継ぎ`);
  }

  persistNow() {
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (this.statePath) fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 1));
  }

  persistSoon() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      fs.writeFile(this.statePath, JSON.stringify(this.state, null, 1), () => {});
    }, 500);
  }

  // 実行中のエージェントを中断し、worktree の後片付けが終わるまで待つ（最大 10 秒）
  async shutdown() {
    this.shuttingDown = true;
    clearInterval(this.minuteTimer);
    clearInterval(this.tickTimer);
    clearInterval(this.planTimer);
    clearInterval(this.protectTimer);
    clearInterval(this.inspectTimer);
    clearTimeout(this.inspectDebounce);
    clearTimeout(this.probeTimer);
    for (const c of this.controllers) c.abort();
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, 10000))]);
  }

  // ---------- エージェント実行（共通） ----------
  async runAgent(agentId, opts, onTokens) {
    const a = this.state.agents[agentId];
    const ctrl = new AbortController();
    this.controllers.add(ctrl);
    (this.ctrlByAgent ||= new Map()).set(agentId, ctrl);
    a.state = 'active';
    this.changed();
    let reported = 0;
    const w = this.state.watchdog;
    const remainingUsd = Math.max(0.5, w.budget.costUsd - w.usedCostUsd);
    const res = await runners[a.runner]({
      ...opts, model: a.model, effort: a.effort, signal: ctrl.signal,
      maxBudgetUsd: this.cfg.perCallUsd ? Math.min(this.cfg.perCallUsd, remainingUsd) : remainingUsd,
      onUsage: (total) => { const d = total - reported; reported = total; this.addUsage(d, 0); onTokens?.(d); this.changed(); },
      onActivity: (text) => { a.activity = text; opts.onActivity?.(text); this.changed(); },
      onRateLimit: (info) => this.updatePlan(info),
    }, this.cfg);
    // モデル別の累計（利用枠との関係を調べるため。キャッシュ読み込みも別に数える）
    const bm = (this.state.watchdog.byModel ||= {});
    for (const [m, u] of Object.entries(res.modelUsage || {})) {
      const x = (bm[m] ||= { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      x.calls++; x.costUsd += u.costUSD || 0; x.inputTokens += u.inputTokens || 0; x.outputTokens += u.outputTokens || 0;
      x.cacheReadTokens += u.cacheReadInputTokens || 0; x.cacheWriteTokens += u.cacheCreationInputTokens || 0;
    }
    // 最終値で途中経過を補正する
    const d = res.tokens - reported;
    this.addUsage(d, res.costUsd || 0);
    onTokens?.(d);
    this.controllers.delete(ctrl);
    this.ctrlByAgent.delete(agentId);
    a.activity = null;
    a.state = 'waiting';
    this.changed();
    return res;
  }

  // ---------- 1. 計画 ----------
  async plan() {
    this.state.run.status = 'planning';
    const route = policy.judge(this.ladder);
    const root = this.newAgent('lead', route);
    this.rootAgent = root;
    this.log('plan', `root (${route.model}/${route.effort}) が計画を作成中`);
    const res = await this.runAgent(root, {
      role: 'planner', cwd: this.repo.mainPath, readOnly: true, schema: SCHEMAS.plan,
      prompt: prompts.plan({ goal: this.cfg.goal, checkCommand: this.cfg.check, maxTasks: this.cfg.maxTasks, catalog: this.kinds.catalog() }),
    });
    if (!res.ok) {
      this.state.run.status = 'failed';
      this.log('fail', `計画に失敗: ${res.error}`);
      return;
    }
    const p = res.output;
    this.addRequests(p.humanRequests, { from: root });
    this.state.project.name = p.name || this.state.project.name;
    this.state.project.successCriteria = p.successCriteria || [];
    if (!this.cfg.check && p.checkCommand) this.state.run.checkCommand = p.checkCommand;
    this.fallbackKind = {};
    for (const spec of p.newKinds || []) this.createKind(spec, root);
    this.state.epics = this.validatePlan(p.epics || []);
    for (const e of this.state.epics) e.lead = root;
    this.requestMissingKinds(root);
    const n = this.state.epics.reduce((s, e) => s + e.tasks.length, 0);
    this.state.run.status = 'running';
    this.log('plan', `計画完了: 中プロジェクト ${this.state.epics.length} 件 / task ${n} 件。検証コマンド: ${this.state.run.checkCommand || '(なし)'}`);
  }

  // root が提案した新しい型を作る。安全柵に触れるなら作らず、土台の型で代用して依頼に残す
  createKind(spec, from) {
    const r = this.kinds.create(spec);
    if (r.kind) {
      this.log('plan', `新しい型「${r.kind.name}」を作成（土台: ${spec.basedOn || 'coder'}）: ${r.kind.description}`);
    } else {
      this.fallbackKind[String(spec.name).toLowerCase()] = String(spec.basedOn || 'coder').toLowerCase();
      this.log('warn', `型「${spec.name}」は作らなかった: ${r.error}`);
      this.addRequests([{ kind: 'decision', blocking: false, title: `型「${spec.name}」を作るか判断してほしい`,
        detail: `${r.error}\n提案内容: ${spec.description}\n必要なら対象 repo の .atv-kinds/${spec.name}.md に定義を置いて起動し直してください（いまは ${spec.basedOn || 'coder'} で代用）。` }], { from });
    }
    this.state.kinds = this.kinds.summary();
  }

  // 使う型に足りないもの（runner・コマンド）があれば、その task を止めて 1 件の依頼にまとめる
  requestMissingKinds(from) {
    const byKind = new Map();
    for (const e of this.state.epics) for (const t of e.tasks) {
      const miss = this.kinds.missing(this.kinds.get(t.kind));
      if (miss.length) (byKind.get(t.kind) || byKind.set(t.kind, { miss, tasks: [] }).get(t.kind)).tasks.push(t);
    }
    for (const [name, { miss, tasks }] of byKind) {
      const req = this.addRequests([{ kind: 'install', blocking: true, title: `型「${name}」に必要な ${miss.join(', ')} を用意してほしい`,
        detail: `${tasks.map((t) => t.id).join(', ')} は ${miss.join(', ')} がないと動かせません。${miss.includes('codex') ? 'Codex CLI を入れて `codex login` してください。' : `\`${miss.join('`, `')}\` を PATH に入れてください。`}用意できたら「対応済み」、この task を諦めるなら「却下」を押してください。` }],
      { from, taskIds: tasks.map((t) => t.id) });
      for (const t of tasks) { t.status = 'blocked'; t.blockedBy = req[0]?.id; }
    }
  }

  validatePlan(epics) {
    const ids = new Set(epics.map((e) => e.id));
    const out = epics.map((e) => ({
      id: String(e.id), title: e.title, brief: e.brief || '', status: 'todo', lead: null, review: null, reviewRounds: 0,
      risk: normRisk(e.risk),
      dependsOn: (e.dependsOn || []).filter((d) => ids.has(d) && d !== e.id),
      tasks: (e.tasks || []).map((t, i) => this.newTask({ ...t, id: t.id || `${e.id}-T${i + 1}` }, e)),
    })).filter((e) => e.tasks.length);
    // 循環依存は切る（計画時の誤りでデッドロックさせない）
    const byId = new Map(out.map((e) => [e.id, e]));
    const visiting = new Set(), done = new Set();
    const visit = (e) => {
      if (done.has(e.id)) return;
      visiting.add(e.id);
      e.dependsOn = e.dependsOn.filter((d) => {
        if (visiting.has(d)) { this.log('warn', `循環依存 ${e.id} → ${d} を除去`); return false; }
        if (byId.has(d)) visit(byId.get(d));
        return byId.has(d);
      });
      visiting.delete(e.id);
      done.add(e.id);
    };
    out.forEach(visit);
    this.cleanNeeds(out);
    return out;
  }

  // 型名を解決する（作れなかった型は土台の型、知らない型は coder）
  kindName(name) {
    const n = String(name || 'coder').toLowerCase();
    return this.kinds?.map.has(n) ? n : this.fallbackKind?.[n] && this.kinds.map.has(this.fallbackKind[n]) ? this.fallbackKind[n] : 'coder';
  }

  // 型が runner を指定していればその梯子を使う（mock はすべて mock）
  ladderFor(kind) {
    if (this.cfg.ladder === 'mock' || kind.runner === 'any') return this.ladder;
    const own = this.ladder.filter((r) => r.runner === kind.runner);
    return own.length >= 3 ? own : policy.LADDERS[kind.runner];
  }

  // task の needs を存在する id に絞り、循環を切る
  cleanNeeds(epics) {
    const all = new Map(epics.flatMap((e) => e.tasks).map((t) => [t.id, t]));
    for (const t of all.values()) if (t.needs) t.needs = t.needs.filter((d) => d !== t.id && all.has(d));
    const visiting = new Set(), seen = new Set();
    const visit = (t) => {
      if (seen.has(t.id) || !t.needs) return;
      visiting.add(t.id);
      t.needs = t.needs.filter((d) => {
        if (visiting.has(d)) { this.log('warn', `task の循環依存 ${t.id} → ${d} を除去`); return false; }
        visit(all.get(d));
        return true;
      });
      visiting.delete(t.id);
      seen.add(t.id);
    };
    all.forEach(visit);
  }

  // task が始められるか: needs があればそれだけ、なければ中プロジェクトの dependsOn
  taskReady(e, t, doneEpics, doneTasks) {
    return t.needs ? t.needs.every((d) => doneTasks.has(d)) : e.dependsOn.every((d) => doneEpics.has(d));
  }

  // --resume で読んだ計画に task 単位の依存がなければ、root に補わせる（計画は作り直さない）
  async inferNeeds() {
    const tasks = this.state.epics.flatMap((e) => e.tasks.map((t) => ({ e, t })));
    if (!tasks.some(({ t }) => t.status !== 'done' && !t.needs)) return;
    const route = policy.judge(this.ladder);
    const agent = this.rootAgent || this.newAgent('lead', route);
    this.log('plan', `task 単位の依存を補う（${route.model}/${route.effort}）`);
    const list = tasks.map(({ e, t }) => `- ${t.id} [${t.status}] ${t.title} — ${t.writeSet.join(', ') || '(none)'} — ${oneLine(t.description, 400)} [epic ${e.id} dependsOn ${e.dependsOn.join(', ') || '-'}]`).join('\n');
    const res = await this.runAgent(agent, { role: 'planner', cwd: this.repo.mainPath, readOnly: true, schema: SCHEMAS.needs, prompt: prompts.needs({ goal: this.cfg.goal, tasks: list }) });
    if (!res.ok) { this.log('warn', `依存の補完に失敗（中プロジェクト単位の依存のまま続行）: ${oneLine(res.error)}`); return; }
    const byId = new Map(tasks.map(({ t }) => [t.id, t]));
    for (const x of res.output.tasks || []) {
      const t = byId.get(x.id);
      if (t && t.status !== 'done') t.needs = x.needs || [];
    }
    for (const { t } of tasks) if (!t.needs && t.status === 'done') t.needs = [];
    this.cleanNeeds(this.state.epics);
    this.log('plan', `task 単位の依存: ${tasks.filter(({ t }) => t.status !== 'done').map(({ t }) => `${t.id}←${t.needs?.join('+') || '∅'}`).join(' / ')}`);
  }

  // --resume で読んだ計画に、人が読む 1 行（brief / headline）がなければ root に補わせる
  async inferBriefs() {
    const all = this.state.epics.flatMap((e) => e.tasks);
    if (this.state.epics.every((e) => e.brief) && all.every((t) => t.brief && (t.status !== 'done' || t.headline))) return;
    const route = policy.judge(this.ladder);
    const agent = this.rootAgent || this.newAgent('lead', route);
    this.log('plan', `ボード用の 1 行の説明を補う（${route.model}/${route.effort}）`);
    const epics = this.state.epics.map((e) => `${e.id} ${e.title}\n${e.tasks.map((t) => `  - ${t.id} [${t.status}] ${t.title} — ${oneLine(t.description, 300)}${t.summary ? ` — result: ${oneLine(t.summary, 300)}` : ''}`).join('\n')}`).join('\n');
    const res = await this.runAgent(agent, { role: 'planner', cwd: this.repo.mainPath, readOnly: true, schema: SCHEMAS.briefs, prompt: prompts.briefs({ goal: this.cfg.goal, epics }) });
    if (!res.ok) { this.log('warn', `説明の補完に失敗: ${oneLine(res.error)}`); return; }
    const eb = new Map((res.output.epics || []).map((x) => [x.id, x.brief]));
    const tb = new Map((res.output.tasks || []).map((x) => [x.id, x]));
    for (const e of this.state.epics) {
      if (!e.brief && eb.get(e.id)) e.brief = eb.get(e.id);
      for (const t of e.tasks) {
        const x = tb.get(t.id);
        if (!x) continue;
        if (!t.brief && x.brief) t.brief = x.brief;
        if (!t.headline && x.headline && t.status === 'done') t.headline = x.headline;
      }
    }
    this.changed();
  }

  // ---------- 点検役 ----------
  // 人がボードで気づくはずのおかしさ（読めない依頼、止まった進み具合、長すぎる task…）を先に見つけて、許された範囲で直す
  inspectSoon(reason, delayMs = 0) {
    if (!(this.cfg.inspectMin > 0) || this.shuttingDown || this.state.run.draining) return;
    if (this.inspectDebounce) return;
    const since = Date.now() - (this.lastInspectAt || 0);
    const wait = Math.max(delayMs, 3 * 60000 - since, 0); // 3 分に 1 回まで
    this.inspectDebounce = setTimeout(() => { this.inspectDebounce = null; this.runInspector(reason); }, wait);
  }

  boardDigest() {
    const nowMs = Date.now();
    const m = (iso) => (iso ? Math.round((nowMs - Date.parse(iso)) / 60000) : null);
    const done = this.state.epics.flatMap((e) => e.tasks).filter((t) => t.status === 'done' && t.attempts.length);
    const durs = done.map((t) => (Date.parse(t.attempts[t.attempts.length - 1].endedAt || t.attempts[0].startedAt) - Date.parse(t.attempts[0].startedAt)) / 60000).filter((x) => x > 0);
    const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null;
    const lines = [`run: ${this.state.run.status}${this.state.run.paused ? ' (paused)' : ''}; average finished task ${avg ?? '?'} min; active agents ${this.activeCount()}/${this.state.watchdog.limits.maxActiveAgents}`];
    for (const e of this.state.epics) {
      lines.push(`EPIC ${e.id} [${e.status}] ${e.title} — brief: ${e.brief || '(none)'}${e.review ? ` — review: ${oneLine(e.review.note, 120)}` : ''}`);
      for (const t of e.tasks) {
        if (t.status === 'done' && e.status === 'done') continue;
        const a = t.attempts[t.attempts.length - 1];
        const p = a?.progress;
        lines.push(`  TASK ${t.id} [${t.status}] ${t.title} — brief: ${t.brief || '(none)'}${t.headline ? ` — headline: ${t.headline}` : ''}`
          + (a ? `\n    attempt ${t.attempts.length} ${a.model}/${a.effort} ${a.result}, running ${m(a.startedAt)} min${a.endedAt ? `, ended ${m(a.endedAt)} min ago` : ''}${a.note ? `, note: ${oneLine(a.note, 200)}` : ''}` : '')
          + (p ? `\n    progress (updated ${m(p.at)} min ago): ${p.steps.map((x) => `${x.done ? '✓' : '○'}${x.title}`).join(' / ')}; now: ${p.now}` : '')
          + (t.status === 'running' && t.activity ? `\n    last tool call: ${oneLine(t.activity, 120)}` : '')
          + (t.status === 'waiting' ? `\n    waiting until ${t.wakeAt}` : '')
          + ((t.notes || []).length ? `\n    inspector notes already given: ${t.notes.slice(-2).map((x) => oneLine(x, 100)).join(' | ')}` : '')
          + (t.attempts.length > 1 ? `\n    earlier attempts: ${t.attempts.slice(0, -1).map((x) => `${x.result}${x.note ? `(${oneLine(x.note, 80)})` : ''}`).join(', ')}` : ''));
      }
    }
    const open = this.state.requests.filter((r) => r.status === 'open');
    lines.push(`OPEN REQUESTS (${open.length}):`);
    for (const r of open) lines.push(`  ${r.id} [${r.kind}${r.blocking ? ', blocking' : ''}] from ${r.from} task ${r.taskId || '-'} age ${m(r.createdAt)} min — title: ${r.title}\n    detail: ${oneLine(r.detail, 400)}`);
    lines.push('RECENT EVENTS:', ...this.state.events.slice(-15).map((x) => `  ${x.t} ${x.kind} ${oneLine(x.msg, 140)}`));
    return lines.join('\n');
  }

  async runInspector(reason) {
    if (this.inspecting || this.shuttingDown || this.state.run.draining) return;
    if (!this.state.epics.length || this.state.run.status === 'done') return;
    this.inspecting = true;
    this.lastInspectAt = Date.now();
    // 一段目: 梯子のいちばん下（haiku/low）が「怪しいか」だけを見る。怪しいときだけ二段目（梯子の 4 段目、sonnet/high）が検査して直す
    const low = this.ladder[0], high = this.ladder[Math.min(3, this.ladder.length - 1)];
    const agent = this.inspectorAgent || (this.inspectorAgent = this.newAgent('inspector', low));
    const set = (r) => Object.assign(this.state.agents[agent], { runner: r.runner, model: r.model, effort: r.effort });
    try {
      const board = this.boardDigest();
      set(low);
      const tri = await this.runAgent(agent, { role: 'inspector', cwd: this.repo.mainPath, readOnly: true, schema: SCHEMAS.triage, prompt: prompts.triage({ board }) });
      if (!tri.ok) { this.log('warn', `点検（一段目）が失敗: ${oneLine(tri.error)}`); return; }
      if (!tri.output.suspicious) {
        this.state.inspector = { at: new Date().toISOString(), reason, stage: 1, findings: [], actions: [], screen: '異常なし' };
        return;
      }
      const flagged = (tri.output.reasons || []).join(' / ');
      this.log('inspect', `点検（${reason}）: 一段目が異常の可能性を報告 → ${high.model}/${high.effort} で検査: ${oneLine(flagged, 160)}`);
      set(high);
      const rules = { restart: 'its progress has not been updated for at least 20 minutes AND it has run at least twice the average finished task duration' };
      const res = await this.runAgent(agent, { role: 'inspector', cwd: this.repo.mainPath, readOnly: true, schema: SCHEMAS.inspect, prompt: prompts.inspect({ goal: this.cfg.goal, board, rules, triage: flagged }) });
      if (!res.ok) { this.log('warn', `点検（二段目）が失敗: ${oneLine(res.error)}`); return; }
      this.applyInspection(res.output, reason);
      this.state.inspector.stage = 2;
      this.state.inspector.screen = flagged;
    } finally { this.state.agents[agent].state = 'finished'; this.inspecting = false; this.changed(); }
  }

  applyInspection(out, reason) {
    const tasks = new Map(this.state.epics.flatMap((e) => e.tasks.map((t) => [t.id, { t, e }])));
    const epics = new Map(this.state.epics.map((e) => [e.id, e]));
    const done = [];
    for (const a of out.actions || []) {
      const r = this.state.requests.find((x) => x.id === a.target && x.status === 'open');
      const te = tasks.get(a.target);
      if (a.type === 'rewrite_request' && r) {
        r.title = oneLine(a.title || r.title, 80); r.detail = String(a.text || r.detail).slice(0, 2000); r.rewrittenBy = 'inspector';
        done.push(`${r.id} の文面を書き直した`);
      } else if (a.type === 'answer_request' && r && ['decision', 'other'].includes(r.kind)) {
        this.resolveRequest(r.id, { reply: `（点検役が回答）${a.text}` });
        done.push(`${r.id} に回答して閉じた（${oneLine(a.reason, 60)}）`);
      } else if (a.type === 'nudge_task' && te) {
        (te.t.notes ||= []).push(String(a.text).slice(0, 600));
        done.push(`${te.t.id} の次の試行に注意を添えた`);
      } else if (a.type === 'restart_task' && te && te.t.status === 'running') {
        // 本当に止まっているときだけ（進み具合が 20 分以上更新されず、平均の 2 倍以上走っている）
        const at = te.t.attempts[te.t.attempts.length - 1];
        const stale = (Date.now() - Date.parse(at.progress?.at || at.startedAt)) / 60000;
        const d = this.state.epics.flatMap((e) => e.tasks).filter((x) => x.status === 'done' && x.attempts.length)
          .map((x) => (Date.parse(x.attempts[x.attempts.length - 1].endedAt || 0) - Date.parse(x.attempts[0].startedAt)) / 60000).filter((x) => x > 0);
        const avg = d.length ? d.reduce((p, q) => p + q, 0) / d.length : Infinity;
        const ran = (Date.now() - Date.parse(at.startedAt)) / 60000;
        if (stale >= 20 && ran >= 2 * avg) {
          (te.t.notes ||= []).push(String(a.text).slice(0, 600));
          te.t.abortReason = `点検役が止めてやり直し: ${oneLine(a.reason, 120)}`;
          this.ctrlByAgent?.get(te.t.agent)?.abort();
          done.push(`${te.t.id} を止めてやり直しに回した`);
        } else done.push(`${te.t.id} のやり直しは見送り（条件を満たさない）`);
      } else if (a.type === 'rewrite_text') {
        const field = a.title === 'brief' ? 'brief' : 'headline';
        if (te) { te.t[field] = oneLine(a.text, 120); done.push(`${te.t.id} の${field === 'brief' ? '説明' : '見出し'}を書き直した`); }
        else if (epics.get(a.target)) { epics.get(a.target).brief = oneLine(a.text, 120); done.push(`${a.target} の説明を書き直した`); }
      } else if (a.type === 'ask_human') {
        this.addRequests([{ kind: 'decision', blocking: false, title: oneLine(a.title, 80), detail: String(a.text).slice(0, 2000) }], { from: 'inspector', taskId: tasks.has(a.target) ? a.target : null });
        done.push(`判断を依頼した: ${oneLine(a.title, 60)}`);
      }
    }
    this.state.inspector = { at: new Date().toISOString(), reason, findings: (out.findings || []).slice(0, 12), actions: done };
    if (done.length || (out.findings || []).length) this.log('inspect', `点検（${reason}）: ${done.join(' / ') || '対応なし'}${(out.findings || []).length ? `。所見: ${(out.findings || []).slice(0, 3).map((f) => oneLine(f.problem, 60)).join(' / ')}` : ''}`);
    // atv 自体の作りに原因があるものは、開発者向けに書き溜める
    const imp = (out.improvements || []).map((x) => String(x).trim()).filter(Boolean);
    if (imp.length) {
      const file = path.join(this.repo.dir, 'improvements.md');
      const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# atv の改善点（点検役が書き溜める）\n';
      const fresh = imp.filter((x) => !have.includes(x));
      if (fresh.length) fs.writeFileSync(file, `${have}\n## ${new Date().toLocaleString('ja-JP')}（${reason}）\n${fresh.map((x) => `- ${x}`).join('\n')}\n`);
    }
    this.schedule();
  }

  // ---------- プロジェクト報告書 ----------
  // 記録（task ごとの意図・試行・結果・批判・レビュー・人間の返答）を時刻順に並べ、root に Markdown で書かせる
  reportRecord() {
    const ev = [];
    const at = (iso) => (iso ? new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '?');
    for (const e of this.state.epics) {
      for (const t of e.tasks) {
        const first = t.attempts[0];
        if (!first) continue;
        ev.push({ t: first.startedAt, s: `[${at(first.startedAt)}] 開始 ${t.id}「${t.title}」（${e.title}）\n  意図: ${t.brief || ''}\n  やること: ${oneLine(t.description, 700)}` });
        t.attempts.forEach((a, i) => {
          ev.push({ t: a.endedAt || a.startedAt, s: `[${at(a.endedAt || a.startedAt)}] ${t.id} 試行${i + 1}（${a.model}/${a.effort}）→ ${a.result}${a.headline ? `: ${a.headline}` : ''}${a.note ? `\n  記録: ${oneLine(a.note, 700)}` : ''}${a.progress?.steps?.length ? `\n  手順: ${a.progress.steps.map((x) => `${x.done ? '✓' : '・'}${x.title}`).join(' / ')}` : ''}` });
        });
        for (const c of t.critiques || []) ev.push({ t: c.at, s: `[${at(c.at)}] ${t.id} 失敗が続いたため critic が検討: ${oneLine(c.diagnosis, 500)}\n  次の進め方: ${oneLine(c.guidance, 500)}` });
        if (t.status === 'done') ev.push({ t: t.attempts[t.attempts.length - 1].endedAt, s: `[${at(t.attempts[t.attempts.length - 1].endedAt)}] 完了 ${t.id}: ${t.headline || ''}\n  結果: ${oneLine(t.summary, 900)}` });
        else ev.push({ t: new Date().toISOString(), s: `[未完了] ${t.id}「${t.title}」: 状態 ${t.status}` });
      }
      if (e.lastReviewNote) ev.push({ t: e.tasks.map((t) => t.attempts[t.attempts.length - 1]?.endedAt).filter(Boolean).sort().pop(), s: `[${e.id} レビュー] ${e.title}: ${oneLine(e.lastReviewNote, 600)}` });
    }
    for (const r of this.state.requests) ev.push({ t: r.createdAt, s: `[${at(r.createdAt)}] 人間への依頼「${r.title}」${r.status !== 'open' ? ` → ${r.status === 'dismissed' ? '却下' : `返答: ${oneLine(r.reply || '対応済み', 400)}`}` : '（未対応）'}` });
    return ev.filter((x) => x.t).sort((a, b) => String(a.t).localeCompare(String(b.t))).map((x) => x.s).join('\n');
  }

  async writeReport(partial) {
    if (this.reporting) return;
    this.reporting = true;
    const run = this.state.run, w = this.state.watchdog;
    try {
      const route = policy.judge(this.ladder);
      const agent = this.newAgent('lead', route);
      this.log('report', `プロジェクト報告書を作成中（${route.model}/${route.effort}${partial ? '、途中までの分' : ''}）`);
      const usage = `${w.usedTokens} tokens, $${w.usedCostUsd.toFixed(2)} (API 換算), 開始 ${run.startedAt}`;
      const res = await this.runAgent(agent, {
        role: 'planner', cwd: this.repo.mainPath, readOnly: true, schema: SCHEMAS.report,
        prompt: prompts.report({ goal: this.cfg.goal, criteria: (this.state.project.successCriteria || []).map((c) => `- ${c}`).join('\n'), record: this.reportRecord(), usage, partial }),
      });
      this.state.agents[agent].state = 'finished';
      const md = res.ok ? String(res.output?.markdown || '').trim() : '';
      if (!md) { this.log('fail', `報告書の作成に失敗: ${oneLine(res.error || '本文が空')}`); return; }
      const file = path.join(this.repo.dir, 'report.md');
      fs.writeFileSync(file, md + '\n');
      run.report = { path: file, at: new Date().toISOString(), partial };
      this.log('report', `報告書を書いた: ${file}`);
    } finally { this.reporting = false; this.changed(); }
  }

  newTask(t, epic) {
    return {
      id: String(t.id), title: t.title, brief: t.brief || '', headline: t.headline || '', description: t.description || '', status: 'todo', agent: null,
      kind: this.kindName(t.kind),
      writeSet: [...new Set((t.writeSet || []).map(normPath).filter(Boolean))],
      risk: t.risk ? normRisk(t.risk) : normRisk(epic.risk),
      needs: Array.isArray(t.needs) ? [...new Set(t.needs.map(String))] : null, // null = 中プロジェクトの dependsOn に従う
      tokens: 0, costUsd: 0, attempts: [], summary: '', activity: null, grants: [],
    };
  }

  // ---------- 2. スケジューラ（1 秒ごと + 状態変化時） ----------
  schedule() {
    const run = this.state.run;
    if (this.shuttingDown) return;
    if (!['running', 'paused', 'waiting-human', 'stuck', 'budget-stopped', 'plan-limit', 'protect-hold', 'done'].includes(run.status)) return;
    if (run.draining) { this.changed(); return; } // 再起動待ち。実行中の agent は各自の finally から戻ってくる
    const lockInfo = locks.compute(this.state);
    const wd = watchdog.evaluate(this.state, lockInfo);
    const w = this.state.watchdog;
    const budgetRatio = Math.max(w.usedTokens / w.budget.tokens, w.usedCostUsd / w.budget.costUsd);
    if (budgetRatio >= 0.9 && !run.frozen) {
      run.frozen = true;
      this.log('watchdog', `予算の ${(budgetRatio * 100).toFixed(0)}% を消費。新規 spawn を停止（実行中の agent は最後まで走らせる）`);
    }
    const vkey = lockInfo.violations.map(([a, b]) => `${a.taskId}/${b.taskId}`).join(', ');
    if (vkey && vkey !== this.lastViolation) this.log('watchdog', `ロック違反を検出: ${vkey}`);
    this.lastViolation = vkey;
    this.checkPlan();
    const canSpawn = () => !run.paused && !run.frozen && !run.planHold && !run.protectHold && !run.draining && this.activeCount() < w.limits.maxActiveAgents;

    // 待ち時間が来た task を戻す
    for (const t of this.state.epics.flatMap((e) => e.tasks)) {
      if (t.status === 'waiting' && Date.now() >= Date.parse(t.wakeAt || 0)) { t.status = 'todo'; t.wakeAt = null; this.log('start', `${t.id}: 待ち時間が来たので再開`); }
    }
    const doneIds = new Set(this.state.epics.filter((e) => e.status === 'done').map((e) => e.id));
    const doneTasks = new Set(this.state.epics.flatMap((e) => e.tasks).filter((t) => t.status === 'done' || t.status === 'review').map((t) => t.id));
    const ready = (e, t) => this.taskReady(e, t, doneIds, doneTasks);
    for (const e of this.state.epics) {
      if (e.status === 'todo' && e.tasks.some((t) => t.status === 'todo' && ready(e, t)) && canSpawn()) {
        e.status = 'running';
        this.startEpic(e);
      }
      if (e.status !== 'running') continue;

      for (const t of e.tasks) {
        if (t.status !== 'todo' || !canSpawn() || !ready(e, t)) continue;
        if (!locks.canAcquire(this.state, t)) {
          if (t.agent) this.state.agents[t.agent].state = 'waiting';
          continue;
        }
        this.runTask(e, t);
      }
      if (e.tasks.every((t) => t.status === 'done') && canSpawn()) this.runReview(e);
    }

    // 全体の状態（ループは止めない。依頼が解決されたり再開されたりしたら続きから動く）
    const busy = this.state.epics.some((e) => e.status === 'review' && e.review?.verdict === 'pending') ||
      this.state.epics.some((e) => e.tasks.some((t) => t.status === 'running' || t.status === 'critique' || t.status === 'waiting'));
    let next = 'running';
    if (this.state.epics.length && this.state.epics.every((e) => e.status === 'done')) next = 'done';
    else if (!busy) {
      const startable = this.state.epics.some((e) => ['running', 'todo'].includes(e.status) && e.tasks.some((t) => t.status === 'todo' && ready(e, t)));
      if (run.frozen) next = 'budget-stopped';
      else if (run.planHold) next = 'plan-limit';
      else if (run.protectHold) next = 'protect-hold';
      else if (run.paused && startable) next = 'paused';
      else if (this.state.epics.some((e) => e.tasks.some((t) => t.status === 'blocked'))) next = 'waiting-human';
      else if (!startable) next = 'stuck';
    }
    if (next !== run.status) {
      run.status = next;
      const msg = { done: 'プロジェクト完了。統合ブランチをレビューしてマージしてください', 'waiting-human': '人間への依頼待ちで止まっています（依頼パネルを確認）', stuck: '進められる task がありません（失敗した task / 差し戻し上限を確認）', 'budget-stopped': '予算上限で停止しました', 'plan-limit': `利用枠で停止中（${run.planHold?.reason || ''}）`, 'protect-hold': '保護パスの変更を検知して停止中（依頼パネルを確認）', paused: '一時停止中', running: '実行中' }[next];
      this.log(next === 'done' ? 'done' : 'watchdog', msg);
      if (next === 'done' && !run.report) this.writeReport(false);
    }
    this.lastWatchdog = wd;
    this.changed();
  }

  startEpic(e) {
    e.baseSha = this.repo.headSha; // レビュー時の差分の起点
    this.log('start', `${e.id} 開始（リスク ${policy.riskScore(e.risk).toFixed(2)}）`);
  }

  // ---------- 3. task の 1 試行 ----------
  runTask(e, t) {
    const p = this.attemptTask(e, t);
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
  }

  async attemptTask(e, t) {
    const failures = t.attempts.filter((a) => a.result === 'fail').length;
    const kind = this.kinds.get(t.kind);
    const route = policy.route(t.risk, failures, this.ladderFor(kind), kind.floor);
    if (!t.agent) t.agent = this.newAgent('worker', route);
    Object.assign(this.state.agents[t.agent], { runner: route.runner, model: route.model, effort: route.effort });
    const attempt = { model: route.model, effort: route.effort, runner: route.runner, result: 'running', startedAt: new Date().toISOString(), tokens: 0 };
    t.attempts.push(attempt);
    t.status = 'running'; // 同期的に running にしてロックを確保する
    this.state.agents[t.agent].state = 'active';
    this.log(failures ? 'escalate' : 'lock', `${t.id} [${kind.name}] 開始 ${route.model}/${route.effort}${failures ? `（${failures} 回失敗後に昇格）` : ''}。ロック: ${t.writeSet.join(', ') || '(なし)'}`);

    let wt = null;
    let needCritic = false;
    let progressTimer = null;
    const finish = (result, note) => {
      attempt.result = result;
      attempt.note = note;
      attempt.endedAt = new Date().toISOString();
      t.activity = null;
      clearInterval(progressTimer);
    };
    try {
      wt = await this.repo.createTaskWorktree(t.id, t.attempts.length);
      // worker が書く進み具合（手順の一覧と今の作業）を数秒ごとに取り込む
      const pfile = path.join(wt.path, '.atv-progress.json');
      progressTimer = setInterval(() => {
        fs.readFile(pfile, 'utf8', (err, txt) => {
          if (err) return;
          try {
            const p = JSON.parse(txt);
            const steps = (Array.isArray(p.steps) ? p.steps : []).slice(0, 12).map((x) => ({ title: oneLine(x.title, 80), done: Boolean(x.done) }));
            const next = { steps, now: oneLine(p.now, 100), at: new Date().toISOString() };
            if (JSON.stringify([next.steps, next.now]) === JSON.stringify([attempt.progress?.steps, attempt.progress?.now])) return; // 変わっていなければ at は最後に書き換わった時刻のまま
            if (!attempt.progress || attempt.progress.steps.filter((x) => x.done).length !== steps.filter((x) => x.done).length) next.stepAt = next.at;
            else next.stepAt = attempt.progress.stepAt;
            attempt.progress = next;
            this.changed();
          } catch { /* 書きかけ */ }
        });
      }, 4000);
      // 前の試行が人間待ちで止まっていたら、その途中の変更を持ち込む
      if (t.carryBranch) {
        const ok = await this.repo.carryOver(wt, t.carryBranch);
        this.log(ok ? 'start' : 'warn', `${t.id}: 前の試行の途中の変更を${ok ? '持ち込んだ' : '持ち込めなかった（マージ競合）'}`);
        t.carryBranch = null;
      }
      const res = await this.runAgent(t.agent, {
        role: 'worker', cwd: wt.path, schema: SCHEMAS.work, task: t, kind,
        tools: [...kind.tools, ...t.grants], disallowed: GUARD.claudeDisallowed,
        replies: this.repliesFor(t.id),
        critique: this.critiqueFor(t),
        prompt: prompts.work({ goal: this.cfg.goal, task: t, epic: e, context: this.contextSummary(t), previous: this.previousEvidence(t), replies: this.repliesFor(t.id), critique: this.critiqueFor(t), kind, guard: `${GUARD.text}\n${this.protector.text()}`, note: (t.notes || []).slice(-2).join('\n') }),
        onActivity: (text) => { t.activity = text; },
      }, (d) => { t.tokens += d; attempt.tokens += d; });
      const granted = this.grantFromDenials(t, res.denials);
      if (!res.ok) throw new Failure(res.error);
      t.costUsd += res.costUsd || 0;
      const out = res.output;

      // 権限が足りずに止まっただけなら、③ で広げて人間を煩わせずにやり直す
      if (out.status === 'blocked' && granted.length && (out.humanRequests || []).every((r) => r.kind === 'access')) {
        if ((await this.repo.commitAll(wt, `atv: ${t.id} (途中) ${t.title}`)).length) { wt.keep = true; t.carryBranch = wt.branch; }
        finish('blocked', `権限不足 → ${granted.join(', ')} を許可して再試行${t.carryBranch ? '（途中の変更は持ち込む）' : ''}`);
        t.status = 'todo';
        return;
      }
      const blocking = this.addRequests(out.humanRequests, { from: t.agent, taskId: t.id, epicId: e.id });

      // 自分のジョブの完了待ち（依頼のない blocked も同じ扱い）: 人間には頼まず、時間が来たら自動で再開する
      if (!blocking.length && (out.status === 'waiting' || out.status === 'blocked')) {
        if ((await this.repo.commitAll(wt, `atv: ${t.id} (途中) ${t.title}`)).length) { wt.keep = true; t.carryBranch = wt.branch; }
        const waits = t.attempts.filter((a) => a.result === 'waiting').length;
        if (waits < this.cfg.maxWaits) {
          const min = Math.min(120, Math.max(2, Number(out.waitMinutes) || 10));
          finish('waiting', out.summary);
          attempt.headline = out.headline || '';
          t.status = 'waiting';
          t.wakeAt = new Date(Date.now() + min * 60000).toISOString();
          this.log('wait', `${t.id} は自分のジョブの完了待ち: ${out.headline || oneLine(out.summary)}（${hhmm(new Date(t.wakeAt))} に再開）`);
          return;
        }
      }
      if (out.status === 'blocked' || out.status === 'waiting' || blocking.length) {
        // 途中の変更は捨てずにブランチに残し、次の試行で持ち込む
        if (!t.carryBranch && (await this.repo.commitAll(wt, `atv: ${t.id} (途中) ${t.title}`)).length) { wt.keep = true; t.carryBranch = wt.branch; }
        // 待ちが続きすぎた（か依頼なしの blocked が続いた）ときだけ、判断を頼む。何を決めてほしいかを書く
        if (!blocking.length) {
          const waits = t.attempts.filter((a) => a.result === 'waiting').length;
          blocking.push(...this.addRequests([{ kind: 'decision', blocking: true, title: `${t.id}「${t.title}」の待ちが ${waits} 回続いている。続けるか決めてほしい`,
            detail: `エージェントは自分で起動したジョブの完了を待っています: ${out.headline || oneLine(out.summary, 200)}\n\n決めてほしいこと: このまま待ち続けるか、やり方を変えるか。\n- 待たせるなら「続けて」と返信（また自動で待ちに戻ります）\n- やり方を変えるなら、その指示を返信\n- この task を諦めるなら「却下」\n\n詳細: ${out.summary || '(なし)'}${t.carryBranch ? `\n途中の変更はブランチ ${t.carryBranch} に残してあり、次の試行に持ち込みます。` : ''}` }],
          { from: t.agent, taskId: t.id, epicId: e.id }));
          t.attempts.forEach((a) => { if (a.result === 'waiting') a.result = 'waited'; }); // 返答後は待ちの回数を数え直す
        }
        finish('blocked', out.summary);
        attempt.headline = out.headline || '';
        t.status = 'blocked';
        this.log('request', `${t.id} は人間待ち: ${blocking.map((r) => r.title).join(' / ') || out.headline || oneLine(out.summary)}`);
        return;
      }
      if (out.status === 'gave_up') throw new Failure(`エージェントが断念: ${out.summary}`);

      const changed = await this.repo.commitAll(wt, `atv: ${t.id} ${t.title}`);
      const outside = changed.filter((f) => !covered(f, t.writeSet));
      if (outside.length) throw new Failure(`writeSet 外を変更: ${outside.slice(0, 5).join(', ')}`);
      if (!changed.length && t.writeSet.length) throw new Failure(`変更がない（summary: ${out.summary}）`);
      // 型ごとの検証: check = 検証コマンド / artifacts = 成果物ファイルがあること（中身はレビューで見る）/ review = レビューだけ
      const made = changed.filter((f) => kind.artifacts.includes(path.extname(f).slice(1).toLowerCase()));
      if (kind.verify === 'artifacts' && !made.length) throw new Failure(`成果物（${kind.artifacts.join(', ')}）がない。変更: ${changed.slice(0, 5).join(', ')}`);

      const check = kind.verify === 'check' ? this.state.run.checkCommand : '';
      if (check && changed.length) {
        t.activity = `検証中: ${check}`;
        this.changed();
        const r = await shell(check, wt.path, this.cfg.checkTimeoutSec * 1000);
        if (!r.ok) throw new Failure(`検証コマンド失敗 (${check}):\n${r.tail}`);
      }
      if (changed.length) await this.repo.merge(wt.branch, `atv: merge ${t.id} ${t.title}`);

      finish('ok');
      t.summary = out.summary;
      t.headline = out.headline || '';
      t.changed = changed;
      t.artifacts = made;
      t.status = 'done';
      this.state.agents[t.agent].state = 'finished';
      this.log('done', `${t.id} 完了: ${out.headline || oneLine(out.summary)}`);
    } catch (err) {
      // オーケストレータの停止・再起動で中断されたなら、失敗に数えず途中の変更を次の試行に持ち込む
      if (this.shuttingDown || t.abortReason) {
        finish('interrupted', t.abortReason || 'オーケストレータの停止・再起動で中断');
        t.abortReason = null;
        if (wt && (await this.repo.commitAll(wt, `atv: ${t.id} (中断時点) ${t.title}`).catch(() => [])).length) { wt.keep = true; t.carryBranch = wt.branch; }
        t.status = 'todo';
        return;
      }
      const note = err instanceof Failure ? err.message : `内部エラー: ${err.message}`;
      finish('fail', note.slice(0, 2000));
      if (wt) attempt.diff = await this.repo.attemptDiff(wt).catch(() => '');
      const n = t.attempts.filter((a) => a.result === 'fail').length;
      if (n >= this.cfg.maxAttempts) {
        t.status = 'failed';
        this.state.agents[t.agent].state = 'finished';
        this.log('fail', `${t.id} が ${n} 回失敗。昇格を止めて人間判断待ち: ${oneLine(note)}`);
      } else {
        // 失敗が続いたら、次の試行の前に critic に原因と進め方を疑わせる
        needCritic = this.cfg.criticAfter > 0 && n >= this.cfg.criticAfter;
        t.status = needCritic ? 'critique' : 'todo';
        this.log('fail', `${t.id} 失敗 (${attempt.model}/${attempt.effort}): ${oneLine(note)}`);
        this.inspectSoon('task が失敗', 60000);
      }
    } finally {
      clearInterval(progressTimer);
      if (wt) await this.repo.removeWorktree(wt);
      this.changed();
      if (needCritic && !this.shuttingDown && !this.state.run.draining) await this.runCritic(e, t); // 再起動待ちなら critic は次のプロセスで
      else if (!this.shuttingDown) this.schedule();
    }
  }

  // ---------- 3'. 批判的レビュー（失敗が続いた task に対する敵対的な検証） ----------
  async runCritic(e, t) {
    const route = policy.judge(this.ladder);
    const critic = this.newAgent('critic', route);
    t.critic = critic;
    const fails = t.attempts.filter((a) => a.result === 'fail').length;
    this.log('critic', `${t.id}: ${fails} 回失敗 → critic (${route.model}/${route.effort}) が原因・進め方・分析の深さを批判的に検証`);
    const attempts = t.attempts.map((a, i) => `#${i + 1} ${a.model}/${a.effort} → ${a.result}\n  evidence: ${a.note || '-'}${a.diff ? `\n  diff of this attempt:\n${a.diff.replace(/^/gm, '    ')}` : ''}`).join('\n\n');
    const earlier = (t.critiques || []).map((c) => `- [${c.verdict}] ${c.diagnosis} / guidance: ${c.guidance}`).join('\n');

    let res;
    try {
      res = await this.runAgent(critic, {
        role: 'critic', cwd: this.repo.mainPath, readOnly: true, schema: SCHEMAS.critique, task: t,
        prompt: prompts.critique({ goal: this.cfg.goal, task: t, epic: e, attempts, context: this.contextSummary(t), earlier, kinds: [...this.kinds.map.keys()].join(', ') }),
        onActivity: (text) => { t.activity = `critic: ${text}`; },
      }, (d) => { t.tokens += d; });
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    this.state.agents[critic].state = 'finished';
    t.activity = null;
    if (this.shuttingDown) { t.status = 'todo'; return; }

    if (!res.ok) {
      t.status = 'todo';
      this.log('fail', `${t.id} の critic が失敗（批判なしで続行）: ${oneLine(res.error)}`);
    } else {
      const out = res.output;
      t.costUsd += res.costUsd || 0;
      (t.critiques ||= []).push({ ...out, by: critic, model: route.model, effort: route.effort, at: new Date().toISOString() });
      this.log('critic', `${t.id} [${out.verdict}] ${oneLine(out.diagnosis, 200)}`);

      if (out.verdict === 'needs_human') {
        const asks = out.humanRequests?.length ? out.humanRequests
          : [{ kind: 'decision', title: `${t.id} の進め方を判断してほしい`, detail: `${out.diagnosis}\n${out.guidance}`, blocking: true }];
        this.addRequests(asks.map((r) => ({ ...r, blocking: true })), { from: critic, taskId: t.id, epicId: e.id });
        t.status = 'blocked';
      } else {
        this.addRequests(out.humanRequests, { from: critic, taskId: t.id, epicId: e.id });
        const r = out.revisedTask;
        if (out.verdict === 'task_is_wrong' && r?.description) {
          const before = t.writeSet.join(', ');
          t.title = r.title || t.title;
          t.description = r.description;
          t.writeSet = [...new Set((r.writeSet || []).map(normPath).filter(Boolean))];
          if (r.kind) t.kind = this.kindName(r.kind);
          this.log('critic', `${t.id} を定義し直し: ${t.title} [${t.kind}]（writeSet ${before || '(なし)'} → ${t.writeSet.join(', ') || '(なし)'}）`);
        } else if (r?.kind && this.kindName(r.kind) !== t.kind) {
          t.kind = this.kindName(r.kind);
          this.log('critic', `${t.id} の型を ${t.kind} に変更`);
        }
        t.status = this.state.requests.some((x) => blocks(x, t)) ? 'blocked' : 'todo';
      }
    }
    this.changed();
    this.schedule();
  }

  // 直近の批判を次の worker に渡す
  critiqueFor(t) {
    const c = t.critiques?.[t.critiques.length - 1];
    if (!c) return '';
    return [`diagnosis: ${c.diagnosis}`, c.flawedAssumptions?.length && `flawed assumptions: ${c.flawedAssumptions.join(' / ')}`,
      c.unansweredQuestions?.length && `questions to answer first: ${c.unansweredQuestions.join(' / ')}`, `guidance: ${c.guidance}`].filter(Boolean).join('\n');
  }

  // ③ その場の拡張: 権限で拒否された操作のうち、安全柵に触れないものを次の試行で許可する
  grantFromDenials(t, denials = []) {
    const add = [];
    for (const d of denials) {
      let rule = null;
      if (d.tool === 'Bash') {
        const cmd = String(d.command || '').trim();
        const head = cmd.split(/\s+/)[0];
        if (head && !guarded(cmd) && !NO_AUTO_GRANT.includes(head) && !/[;&|`$<>\/]/.test(head)) rule = `Bash(${head}:*)`;
      } else if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'].includes(d.tool)) rule = d.tool; // ファイル系の拒否は worktree 外への操作なので広げない
      if (rule && !t.grants.includes(rule) && !add.includes(rule) && !GUARD.claudeDisallowed.includes(rule)) add.push(rule);
    }
    if (add.length) {
      t.grants.push(...add);
      this.log('control', `${t.id}: 権限で拒否された操作を次の試行から許可: ${add.join(', ')}`);
    }
    return add;
  }

  // 後続 task に渡す共有メモリ。完了 task の要約だけ（トークン節約のため 1 行ずつ）
  contextSummary(except) {
    const lines = this.state.epics.flatMap((e) => e.tasks)
      .filter((t) => t.status === 'done' && t !== except && t.summary)
      .slice(-15).map((t) => `- ${t.id} ${t.title}: ${oneLine(t.summary, 200)}`);
    return lines.join('\n');
  }

  previousEvidence(t) {
    const last = [...t.attempts].reverse().find((a) => ['fail', 'blocked', 'interrupted'].includes(a.result));
    return last ? `(${last.model}/${last.effort}) ${last.note}` : '';
  }

  repliesFor(taskId) {
    return this.state.requests.filter((r) => (r.taskIds || [r.taskId]).includes(taskId) && r.status !== 'open')
      .map((r) => `- 「${r.title}」→ ${r.status === 'dismissed' ? '対応しない（別の方法で進めること）' : r.reply || '対応済み'}`).join('\n');
  }

  // ---------- 4. レビュー ----------
  async runReview(e) {
    e.status = 'review';
    e.tasks.forEach((t) => { t.status = 'review'; }); // レビュー中も writeSet を保持する
    const route = policy.judge(this.ladder);
    const reviewer = this.newAgent('reviewer', route);
    e.review = { reviewer, verdict: 'pending', note: 'テスト・差分レビュー中' };
    this.log('review', `${e.id} をレビューへ（${route.model}/${route.effort}）`);

    const paths = [...new Set(e.tasks.flatMap((t) => t.writeSet))];
    let res;
    try {
      const diff = await this.repo.diff(e.baseSha, paths);
      res = await this.runAgent(reviewer, {
        role: 'reviewer', cwd: this.repo.mainPath, readOnly: true, schema: SCHEMAS.review,
        prompt: prompts.review({ goal: this.cfg.goal, epic: e, diff, checkCommand: this.state.run.checkCommand, artifacts: e.tasks.flatMap((t) => t.artifacts || []) }),
        onActivity: (text) => { e.review.note = `レビュー中: ${text}`; },
      });
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    this.state.agents[reviewer].state = 'finished';
    e.tasks.forEach((t) => { t.status = 'done'; });

    if (!res.ok) {
      e.review = { reviewer, verdict: 'needs-human', note: `レビュー実行に失敗: ${oneLine(res.error, 200)}` };
      this.log('fail', `${e.id} のレビューに失敗: ${oneLine(res.error)}`);
    } else {
      const out = res.output;
      this.addRequests(out.humanRequests, { from: reviewer, epicId: e.id });
      if (out.verdict === 'accept' || !out.fixes?.length) {
        e.status = 'done';
        e.review = null;
        e.lastReviewNote = out.note;
        this.log('accept', `${e.id} 承認 → 完了。${oneLine(out.note)}`);
      } else if (e.reviewRounds >= this.cfg.maxReviewRounds) {
        e.review = { reviewer, verdict: 'needs-human', note: `差し戻し上限 (${this.cfg.maxReviewRounds} 回)。${out.note}` };
        this.log('reject', `${e.id} 差し戻しが上限に達したため人間判断待ち`);
      } else {
        e.reviewRounds++;
        out.fixes.forEach((f, i) => e.tasks.push(this.newTask({ kind: 'coder', ...f, id: `${e.id}-F${e.reviewRounds}${String.fromCharCode(97 + i)}`, risk: e.risk }, e)));
        e.status = 'running';
        e.review = null;
        e.lastReviewNote = out.note;
        this.log('reject', `${e.id} 差し戻し: ${oneLine(out.note)} → 修正 task ${out.fixes.length} 件を追加`);
      }
    }
    this.changed();
    this.schedule();
  }

  // ---------- 5. 人間への依頼 ----------
  addRequests(list, { from, taskId = null, epicId = null, taskIds = null }) {
    const added = [];
    for (const r of list || []) {
      // 同じ task から同じ依頼が繰り返されたら重ねない
      const dup = this.state.requests.find((x) => x.status === 'open' && x.taskId === taskId && x.title === r.title);
      if (dup) { added.push(dup); continue; }
      const ids = taskIds || (taskId ? [taskId] : []);
      const req = { id: `R${++this.reqSeq}`, kind: r.kind, title: r.title, detail: r.detail, blocking: Boolean(r.blocking && ids.length), status: 'open', reply: '', from, taskId: ids[0] || null, taskIds: ids, epicId, createdAt: new Date().toISOString() };
      this.state.requests.push(req);
      added.push(req);
      this.log('request', `依頼 ${req.id} [${req.kind}] ${req.title}${req.blocking ? '（ブロッキング）' : ''}`);
      if (from !== 'inspector') this.inspectSoon('依頼が出た', 60000);
    }
    return added.filter((r) => r.blocking);
  }

  resolveRequest(id, { reply = '', dismiss = false } = {}) {
    const r = this.state.requests.find((x) => x.id === id);
    if (!r) throw new Error(`依頼 ${id} が見つからない`);
    r.status = dismiss ? 'dismissed' : 'resolved';
    r.reply = String(reply).slice(0, 2000);
    r.resolvedAt = new Date().toISOString();
    this.log('request', `${r.id} を${dismiss ? '却下' : '対応済み'}に${r.reply ? `: ${oneLine(r.reply)}` : ''}`);
    // ブロッキングの依頼が全部片付いた task は再開
    for (const t of this.state.epics.flatMap((e) => e.tasks)) {
      if (t.status === 'blocked' && !this.state.requests.some((x) => blocks(x, t))) {
        t.status = 'todo';
        this.log('start', `${t.id} を再開（依頼への返答つき）`);
      }
    }
    this.schedule();
  }

  // ---------- 操作 ----------
  control(action, arg = {}) {
    const run = this.state.run;
    if (action === 'pause') { run.paused = true; this.log('control', '一時停止（新規 spawn なし、実行中は継続）'); }
    else if (action === 'resume') { run.paused = false; this.log('control', '再開'); }
    else if (action === 'unfreeze') {
      const w = this.state.watchdog;
      w.budget.tokens = Math.round(w.budget.tokens * 1.5);
      w.budget.costUsd = Math.round(w.budget.costUsd * 1.5 * 100) / 100;
      run.frozen = false;
      this.log('control', `予算を 1.5 倍に拡張して再開（${w.budget.tokens} tok / $${w.budget.costUsd}）`);
    } else if (action === 'restart') {
      if (run.draining) throw new Error('再起動の準備中');
      const mode = arg.mode === 'now' ? 'now' : 'drain';
      run.draining = true;
      run.status = 'restarting';
      this.log('control', mode === 'drain' ? '再起動を準備中: 新規 spawn を止め、実行中の agent の完了を待つ' : '今すぐ再起動: 実行中の agent を中断する');
      this.emit('restart', { mode });
      return;
    } else if (action === 'report') {
      this.writeReport(this.state.run.status !== 'done');
      return;
    } else if (action === 'protect-ok') {
      if (!run.protectHold) throw new Error('保護パスで止まっていない');
      run.protectHold = null;
      this.log('control', '保護パスの変更を人間が確認。今の状態を新しい基準にして再開');
      this.checkingProtected = true; // 基準を取り直すまで検知を止める
      this.protector.rebaseline().then(() => { this.checkingProtected = false; this.schedule(); });
    } else if (action === 'unhold') {
      if (!run.planHold) throw new Error('利用枠で止まっていない');
      run.planOverride = { window: run.planHold.window, until: run.planHold.until };
      this.log('control', `利用枠の停止を人間の判断で解除（${run.planHold.reason}。この窓のリセットまで再停止しない）`);
      run.planHold = null;
    } else if (action === 'retry') {
      const t = this.state.epics.flatMap((e) => e.tasks).find((x) => x.id === arg.taskId && x.status === 'failed');
      if (!t) throw new Error(`再試行できる task がない: ${arg.taskId}`);
      t.status = 'todo';
      this.log('control', `${t.id} を人間の判断で再試行（梯子は続きから）`);
    } else if (action === 'approve') {
      const e = this.state.epics.find((x) => x.id === arg.epicId && x.review?.verdict === 'needs-human');
      if (!e) throw new Error(`承認待ちの epic がない: ${arg.epicId}`);
      e.status = 'done';
      e.review = null;
      this.log('accept', `${e.id} を人間が承認`);
    } else throw new Error(`未知の操作: ${action}`);
    this.schedule();
  }
}

class Failure extends Error {}

// 依頼 r が task t を止めているか
const blocks = (r, t) => r.blocking && r.status === 'open' && (r.taskIds || [r.taskId]).includes(t.id);

const oneLine = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const normRisk = (r = {}) => ({ complexity: clamp01(r.complexity ?? 0.5), uncertainty: clamp01(r.uncertainty ?? 0.5), blast: clamp01(r.blast ?? 0.5) });

function shell(cmd, cwd, timeout) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout, maxBuffer: 32 * 1024 * 1024, shell: '/bin/sh' }, (err, stdout, stderr) => {
      resolve({ ok: !err, tail: `${stdout}\n${stderr}`.trim().slice(-3000) });
    });
  });
}

module.exports = { Orchestrator };
