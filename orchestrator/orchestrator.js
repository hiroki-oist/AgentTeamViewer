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
const { Kinds, GUARD, NO_AUTO_GRANT, guarded, effortFor } = require('./kinds.js');
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
      lessons: [], // この run で分かった落とし穴と避け方。全 worker の指示に載せる
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
    // リセット時刻を過ぎた窓の値は古い（測り直すまで分からない）。それで止めると、リセットのたびに「再開→停止」を繰り返す
    const fresh = (x) => (x && (!x.resetsAt || Date.parse(x.resetsAt) > Date.now()) ? x : null);
    const f = fresh(p.fiveHour), d = fresh(p.sevenDay);
    const weekUsedByRun = d ? d.utilization - (p.weekStart ?? d.utilization) : 0;
    let hold = null;
    if (d && L.planWeekStop > 0 && d.utilization >= L.planWeekStop) hold = { reason: `週の枠が ${pct(d.utilization)}（停止 ${pct(L.planWeekStop)}）`, until: d.resetsAt, window: 'seven_day' };
    else if (d && L.planWeekShare > 0 && weekUsedByRun >= L.planWeekShare) hold = { reason: `この run で週の枠を ${pct(weekUsedByRun)} 使用（上限 ${pct(L.planWeekShare)}）`, until: d.resetsAt, window: 'run_share' };
    else if (f && L.planFiveHourStop > 0 && f.utilization >= L.planFiveHourStop) hold = { reason: `5 時間枠が ${pct(f.utilization)}（停止 ${pct(L.planFiveHourStop)}）`, until: f.resetsAt, window: 'five_hour' };
    else if (p.status === 'rejected' && (f || d)) hold = { reason: '利用枠の上限に到達', until: (f?.utilization >= (d?.utilization ?? 0) ? f : d)?.resetsAt, window: 'rejected' };
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

  // メモリの見張り: 空きが --mem-min-gb を下回ったら新規 spawn を止める（エージェントが起動したジョブの積み過ぎで
  // マシンごと落ちるのを防ぐ）。空きが 1.5 倍まで戻れば自動で解除する
  checkMemory() {
    let info;
    try {
      if (process.platform === 'darwin') {
        // macOS には /proc が無い。vm_stat の空き + 使っていない（inactive・speculative・purgeable）ページを「すぐ使える量」とみなす
        const vm = require('node:child_process').execFileSync('vm_stat', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const page = Number((vm.match(/page size of (\d+)/) || [])[1] || 16384);
        const pg = (k) => Number((vm.match(new RegExp(`${k}:\\s+(\\d+)`)) || [])[1] || 0);
        const avail = (pg('Pages free') + pg('Pages inactive') + pg('Pages speculative') + pg('Pages purgeable')) * page;
        info = { availGb: avail / 1073741824, totalGb: require('node:os').totalmem() / 1073741824 };
      } else {
        const t = fs.readFileSync('/proc/meminfo', 'utf8');
        const kb = (k) => Number((t.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
        info = { availGb: kb('MemAvailable') / 1048576, totalGb: kb('MemTotal') / 1048576 };
      }
    } catch { return; }
    const w = this.state.watchdog, run = this.state.run, min = this.cfg.memMinGb || 0;
    w.mem = { availGb: Math.round(info.availGb * 10) / 10, totalGb: Math.round(info.totalGb), minGb: min };
    if (!(min > 0)) return;
    if (!run.memHold && info.availGb < min) {
      run.memHold = { availGb: w.mem.availGb, at: new Date().toISOString() };
      let top = '';
      try { top = psByMemory().split('\n').slice(0, 6).map((l) => l.trim()).filter(Boolean).map((l) => { const [rss, et, ...a] = l.split(/\s+/); return `${(Number(rss) / 1048576).toFixed(1)} GB  ${et}  ${a.join(' ').slice(0, 120)}`; }).join('\n'); } catch { /* ps がない */ }
      run.memHold.top = top;
      this.log('watchdog', `メモリの空きが ${w.mem.availGb} GB（下限 ${min} GB）。新規 spawn を停止`);
      this.addRequests([{ kind: 'decision', blocking: false, title: `メモリの空きが ${w.mem.availGb} GB まで減った。重いジョブを減らしてほしい`,
        detail: `空きが下限 ${min} GB を下回ったので、新しいエージェントを立てるのを止めています（空きが ${Math.round(min * 1.5)} GB に戻れば自動で再開）。\nメモリを多く使っているプロセス:\n${top}`,
        options: [{ label: '自然に空くのを待つ', description: '動いているジョブが終わるのを待つ。何もしない' }, { label: '重いジョブを止める', description: '返答欄にどれを止めるか書く。点検役か次の worker が止める' }],
        recommended: '自然に空くのを待つ' }], { from: 'watchdog' });
      this.inspectSoon('メモリ不足', 0);
      this.schedule();
    } else if (run.memHold && info.availGb >= min * 1.5) {
      this.log('watchdog', `メモリの空きが ${w.mem.availGb} GB に戻った。再開`);
      run.memHold = null;
      this.schedule();
    }
  }

  // ディスクの見張り: worker が作る一時コピー（Unity の Library など、1 つ数 GB）が溜まるとディスクが満杯になり、
  // すべての検証が ENOSPC で落ちる。空きが --disk-min-gb を下回ったら新規 spawn を止め、終わった task の一時フォルダを消す
  checkDisk() {
    const min = this.cfg.diskMinGb || 0;
    let freeGb;
    try {
      const vols = [this.repo?.root, this.tmpBase()].filter(Boolean);
      freeGb = Math.min(...vols.map((v) => { const s = fs.statfsSync(v); return (s.bavail * s.bsize) / 1073741824; }));
    } catch { return; }
    const w = this.state.watchdog, run = this.state.run;
    w.disk = { freeGb: Math.round(freeGb * 10) / 10, minGb: min };
    if (!(min > 0)) return;
    if (!run.diskHold && freeGb < min) {
      run.diskHold = { freeGb: w.disk.freeGb, at: new Date().toISOString() };
      const freed = this.cleanFinishedTmp();
      this.log('watchdog', `ディスクの空きが ${w.disk.freeGb} GB（下限 ${min} GB）。新規 spawn を停止し、終わった task の一時フォルダ ${freed} 個を消した`);
      this.inspectSoon('ディスク不足', 0);
      this.schedule();
    } else if (run.diskHold && freeGb >= min * 1.5) {
      this.log('watchdog', `ディスクの空きが ${w.disk.freeGb} GB に戻った。再開`);
      run.diskHold = null;
      this.schedule();
    }
  }

  tmpBase() { return process.platform === 'win32' ? require('node:os').tmpdir() : '/tmp'; }

  // 完了・失敗・やめた task の一時フォルダを消す（動いている・待っている task のものは残す）
  cleanFinishedTmp() {
    let n = 0;
    for (const t of this.state.epics.flatMap((e) => e.tasks)) {
      if (!['done', 'failed', 'dropped'].includes(t.status)) continue;
      const dir = this.taskTmpPath(t);
      if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); n++; }
    }
    return n;
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
    this.memTimer = setInterval(() => this.checkMemory(), 5000);
    this.checkMemory();
    this.diskTimer = setInterval(() => this.checkDisk(), 30000);
    this.checkDisk();
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
      // 依存と説明を補い終わるまでは task を始めない（依存が分かる前に走り出さないように）
      this.state.run.status = 'planning';
      await this.inferNeeds();
      await this.inferBriefs();
      this.state.run.status = 'running';
    } else await this.plan();
    this.schedule();
  }

  // 前の run の state.json から続きを始める（計画・task の状態・依頼・使用量を引き継ぐ）。
  // 実行中だったものは中断扱いで todo に戻し、レビュー中だった epic はレビューし直す
  restore(prev) {
    const s = this.state;
    s.project = prev.project;
    s.requests = prev.requests || [];
    s.lessons = prev.lessons || [];
    s.events = [...(prev.events || []), { t: hhmm(), kind: 'start', msg: '--resume: 前の状態から再開' }];
    s.run.startedAt = prev.run?.startedAt || s.run.startedAt;
    // 人が「この枠は無視して続ける」と決めたことは、再起動しても引き継ぐ（同じ窓のリセットまで）
    if (prev.run?.planOverride) s.run.planOverride = prev.run.planOverride;
    s.run.checkCommand = this.cfg.check || prev.run?.checkCommand || '';
    s.run.codexSandboxed = Boolean(prev.run?.codexSandboxed);
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
        if (n.status !== 'done') n.writeSet = this.splitShared(n.id, n.writeSet);
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
    clearInterval(this.memTimer);
    clearInterval(this.inspectTimer);
    clearInterval(this.diskTimer);
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
  ladderFor(kind, t = null) {
    if (this.cfg.ladder === 'mock') return this.ladder;
    // codex の sandbox で止まった task・run では、どの runner でもよい型を Claude で動かす
    if (kind.runner !== 'codex' && (t?.runnerPin === 'claude' || (this.state.run.codexSandboxed && this.cfg.codexSandbox !== 'danger-full-access'))) return policy.LADDERS.claude;
    if (kind.runner === 'any') return this.ladder;
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

  // ---------- 計画の立て直し ----------
  // 完了した task と統合ブランチは残し、goal を読み直して、残りの task を「残す / やめる / 足す」に分ける。
  // 立て直した計画は一時停止の状態で出し、人が確かめてから再開する
  async replan(reason) {
    const run = this.state.run;
    if (this.replanning) throw new Error('立て直しの最中');
    if (this.activeCount() > 0 && !run.paused) throw new Error('先に一時停止し、動いているエージェントが終わるのを待つこと');
    this.replanning = true;
    run.paused = true;
    try {
      if (this.cfg.goalFile) { try { this.cfg.goal = fs.readFileSync(this.cfg.goalFile, 'utf8').trim(); this.state.project.goal = this.cfg.goal; } catch { /* 読めなければ前の goal */ } }
      const route = policy.judge(this.ladder);
      const agent = this.rootAgent || this.newAgent('lead', route);
      Object.assign(this.state.agents[agent], { runner: route.runner, model: route.model, effort: route.effort });
      this.log('plan', `計画を立て直し中（${route.model}/${route.effort}）: ${oneLine(reason, 120)}`);
      const digest = this.state.epics.map((e) => `EPIC ${e.id} [${e.status}] ${e.title} — ${e.brief || ''}\n${e.tasks.map((t) => `  - ${t.id} [${t.status}] ${t.title} — ${t.brief || ''}${t.summary ? ` — result: ${oneLine(t.summary, 400)}` : ''}${t.needs?.length ? ` (needs ${t.needs.join('+')})` : ''}`).join('\n')}`).join('\n');
      const nextEpic = `E${Math.max(0, ...this.state.epics.map((e) => Number(String(e.id).replace(/\D/g, '')) || 0)) + 1}`;
      const res = await this.runAgent(agent, { role: 'planner', cwd: this.repo.mainPath, readOnly: true, schema: SCHEMAS.replan,
        prompt: prompts.replan({ goal: this.cfg.goal, reason, state: digest, catalog: this.kinds.catalog(), nextEpic, maxTasks: this.cfg.maxTasks }) });
      if (!res.ok) { this.log('fail', `計画の立て直しに失敗: ${oneLine(res.error)}`); return; }
      const out = res.output;
      const keep = new Set(out.keep || []);
      const dropped = [];
      for (const e of this.state.epics) for (const t of e.tasks) {
        if (t.status === 'done' || keep.has(t.id)) continue;
        const why = (out.drop || []).find((d) => d.id === t.id)?.reason || '立て直しで不要になった';
        t.status = 'dropped'; t.droppedReason = why; t.wakeAt = null;
        dropped.push(t.id);
      }
      for (const e of this.state.epics) if (e.status !== 'done' && e.tasks.every((t) => t.status === 'dropped' || t.status === 'done')) e.status = e.tasks.some((t) => t.status === 'done') ? 'done' : 'dropped';
      const known = new Set(this.state.epics.map((e) => e.id));
      const fresh = this.validatePlan((out.epics || []).filter((e) => !known.has(String(e.id))));
      // 既存の epic や task を dependsOn / needs に書いてよい（validatePlan は新しい epic の中だけを見るので、ここで戻す）
      const allTasks = new Set([...this.state.epics.flatMap((e) => e.tasks.map((t) => t.id)), ...fresh.flatMap((e) => e.tasks.map((t) => t.id))]);
      const allEpics = new Set([...known, ...fresh.map((e) => e.id)]);
      for (const src of out.epics || []) {
        const e = fresh.find((x) => x.id === String(src.id));
        if (!e) continue;
        e.dependsOn = (src.dependsOn || []).filter((d) => allEpics.has(d) && d !== e.id);
        for (const st of src.tasks || []) { const t = e.tasks.find((x) => x.id === st.id); if (t && Array.isArray(st.needs)) t.needs = st.needs.filter((d) => allTasks.has(d) && d !== t.id); }
        e.lead = agent;
      }
      this.state.epics.push(...fresh);
      // 残した task が、やめた task を前提にしていたら外す（永久に満たされない前提で止まらないように）
      const droppedSet = new Set(dropped);
      for (const t of this.state.epics.flatMap((e) => e.tasks)) {
        const gone = (t.needs || []).filter((d) => droppedSet.has(d));
        if (gone.length) { t.needs = t.needs.filter((d) => !droppedSet.has(d)); this.log('warn', `${t.id}: やめた task（${gone.join(', ')}）を前提から外した`); }
      }
      this.cleanNeeds(this.state.epics);
      this.addRequests(out.humanRequests, { from: agent });
      const n = fresh.reduce((a, e) => a + e.tasks.length, 0);
      run.replan = { at: new Date().toISOString(), reason, note: out.note, kept: [...keep], dropped, added: fresh.map((e) => e.id) };
      this.log('plan', `計画を立て直した: 残す ${keep.size} / やめる ${dropped.length} / 新しい中プロジェクト ${fresh.length} 件（task ${n} 件）。${oneLine(out.note, 200)}`);
      this.addRequests([{ kind: 'decision', blocking: false, title: '立て直した計画を確かめて再開してほしい',
        detail: `${out.note}\n\nやめた task: ${dropped.join(', ') || 'なし'}\n新しい中プロジェクト: ${fresh.map((e) => `${e.id} ${e.title}`).join(' / ') || 'なし'}\n\n一時停止しています。よければボードの ▶ 再開を押してください。`,
        options: [{ label: 'この計画で再開', description: '▶ 再開を押すのと同じ' }, { label: '直してほしい', description: '返答欄に直してほしい点を書く。それを理由にもう一度立て直す' }], recommended: 'この計画で再開' }], { from: agent });
    } finally { this.replanning = false; this.changed(); this.schedule(); }
  }

  // ---------- 点検役 ----------
  // 人がボードで気づくはずのおかしさ（読めない依頼、止まった進み具合、長すぎる task…）を先に見つけて、許された範囲で直す
  inspectSoon(reason, delayMs = 0) {
    // 利用枠で止まっている間は呼ばない（点検役も同じ枠を使う）
    if (!(this.cfg.inspectMin > 0) || this.shuttingDown || this.state.run.draining || this.state.run.planHold) return;
    if (this.inspectDebounce) return;
    const since = Date.now() - (this.lastInspectAt || 0);
    const wait = Math.max(delayMs, 3 * 60000 - since, 0); // 3 分に 1 回まで
    this.inspectDebounce = setTimeout(() => { this.inspectDebounce = null; this.runInspector(reason); }, wait);
  }

  // ---------- 学びの共有 ----------
  // ある task が踏んだ落とし穴を、この run のほかの全 task に伝える（同じ失敗を別の task で繰り返さない）
  addLesson(text, from) {
    const s = oneLine(text, 300);
    if (!s || s.length < 8) return false;
    const key = s.replace(/[\s、。,.!?「」（）()]/g, '').toLowerCase();
    const list = (this.state.lessons ||= []);
    if (list.some((l) => l.key === key || (key.length > 30 && (l.key.includes(key.slice(0, 30)) || key.includes(l.key.slice(0, 30)))))) return false;
    list.push({ text: s, key, from, at: new Date().toISOString() });
    if (list.length > 40) list.splice(0, list.length - 40);
    this.log('learn', `学びを共有（${from}）: ${oneLine(s, 140)}`);
    return true;
  }

  lessonsText() {
    return (this.state.lessons || []).map((l) => `- ${l.text}`).join('\n');
  }

  // ---------- 流れ（停滞の検知と、task が何を待っているか） ----------
  lastDoneAt() {
    const ends = this.state.epics.flatMap((e) => e.tasks).filter((t) => t.status === 'done' || t.status === 'review').map((t) => Date.parse(t.attempts.at(-1)?.endedAt || 0)).filter(Boolean);
    return Math.max(Date.parse(this.state.run.startedAt), ...ends);
  }

  waitReason(e, t, doneEpics, doneTasks) {
    if (t.needs) {
      const miss = t.needs.filter((d) => !doneTasks.has(d));
      if (miss.length) return `needs ${miss.join(', ')}`;
    } else {
      const miss = e.dependsOn.filter((d) => !doneEpics.has(d));
      if (miss.length) return `epic waits for ${miss.join(', ')}`;
    }
    const { held } = locks.compute(this.state);
    const by = [...new Set(held.filter((h) => h.taskId !== t.id && t.writeSet.some((p) => locks.conflicts(h.path, p))).map((h) => h.taskId))];
    if (by.length) return `writeSet locked by ${by.join(', ')}`;
    return 'ready (waiting for a free agent slot or the next scheduler tick)';
  }

  flowDigest() {
    const all = this.state.epics.flatMap((e) => e.tasks.map((t) => ({ e, t })));
    const doneEpics = new Set(this.state.epics.filter((e) => e.status === 'done' || e.status === 'dropped').map((e) => e.id));
    const doneTasks = new Set(all.filter(({ t }) => t.status === 'done' || t.status === 'review').map(({ t }) => t.id));
    const open = all.filter(({ t }) => !['done', 'dropped', 'review'].includes(t.status));
    const lines = [`FLOW: ${doneTasks.size}/${all.length} tasks done; last task finished ${Math.round((Date.now() - this.lastDoneAt()) / 60000)} min ago; active agents ${this.activeCount()}/${this.state.watchdog.limits.maxActiveAgents}`];
    // 未完の task を、何本の未完 task が（直接・間接に）待っているか
    const blocks = new Map();
    for (const { t } of open) for (const d of t.needs || []) if (!doneTasks.has(d)) blocks.set(d, [...(blocks.get(d) || []), t.id]);
    const reach = (id, seen = new Set()) => { for (const x of blocks.get(id) || []) if (!seen.has(x)) { seen.add(x); reach(x, seen); } return seen; };
    const ranked = [...blocks.keys()].map((id) => [id, reach(id).size]).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (ranked.length) lines.push(`critical path (unfinished task → how many unfinished tasks wait for it, directly or not): ${ranked.map(([id, n]) => `${id}→${n}`).join(', ')}`);
    for (const { e, t } of open) if (t.status === 'todo') lines.push(`  ${t.id} todo: ${this.waitReason(e, t, doneEpics, doneTasks)}`);
    return lines.join('\n');
  }

  // 停滞を見つけたら点検役を呼ぶ（人には知らせず、点検役に解決させる）
  checkStall() {
    const run = this.state.run;
    if (run.paused || run.draining || run.planHold || run.status === 'done' || !this.state.epics.length) return;
    const now = Date.now();
    const remaining = this.state.epics.some((e) => e.tasks.some((t) => ['todo', 'waiting', 'running', 'critique', 'blocked'].includes(t.status)));
    if (!remaining) { this.idleSince = null; return; }
    if (this.activeCount() === 0) this.idleSince ||= now; else this.idleSince = null;
    const noDone = (now - this.lastDoneAt()) / 60000;
    const idle = this.idleSince ? (now - this.idleSince) / 60000 : 0;
    if ((noDone >= 30 || idle >= 15) && now - (this.lastStallAt || 0) >= 15 * 60000) {
      this.lastStallAt = now;
      this.log('watchdog', `停滞: ${Math.round(noDone)} 分 task が完了していない${idle ? `・エージェントが ${Math.round(idle)} 分 0 本` : ''} → 点検役が原因を取り除く`);
      this.inspectSoon('停滞', 0);
    }
  }

  boardDigest() {
    const nowMs = Date.now();
    const m = (iso) => (iso ? Math.round((nowMs - Date.parse(iso)) / 60000) : null);
    const done = this.state.epics.flatMap((e) => e.tasks).filter((t) => t.status === 'done' && t.attempts.length);
    const durs = done.map((t) => (Date.parse(t.attempts[t.attempts.length - 1].endedAt || t.attempts[0].startedAt) - Date.parse(t.attempts[0].startedAt)) / 60000).filter((x) => x > 0);
    const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null;
    const lines = [`run: ${this.state.run.status}${this.state.run.paused ? ' (paused)' : ''}; average finished task ${avg ?? '?'} min; active agents ${this.activeCount()}/${this.state.watchdog.limits.maxActiveAgents}`];
    const mem = this.state.watchdog.mem;
    if (mem) lines.push(`memory: ${mem.availGb} GB free of ${mem.totalGb} GB (spawns stop below ${mem.minGb} GB)`);
    const disk = this.state.watchdog.disk;
    if (disk) lines.push(`disk: ${disk.freeGb} GB free (spawns stop below ${disk.minGb} GB). Temp copies must live under each task's $TMPDIR, which is deleted when the task ends.`);
    try {
      const jobs = psByMemory().split('\n').slice(0, 8).map((l) => l.trim()).filter(Boolean)
        .map((l) => { const [rss, et, ...a] = l.split(/\s+/); return `  ${(Number(rss) / 1048576).toFixed(1)} GB, running ${et}: ${a.join(' ').slice(0, 110)}`; });
      lines.push('largest processes on this machine:', ...jobs);
    } catch { /* ps がない */ }
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
          + ((t.notes || []).length ? `\n    notes already given to this task (shortened here only; the task gets them in full): ${t.notes.slice(-2).map((x) => (x.length > 300 ? `${oneLine(x, 300)}…[shortened]` : oneLine(x, 300))).join(' | ')}` : '')
          + (t.attempts.length > 1 ? `\n    earlier attempts: ${t.attempts.slice(0, -1).map((x) => `${x.result}${x.note ? `(${oneLine(x.note, 80)})` : ''}`).join(', ')}` : ''));
      }
    }
    const open = this.state.requests.filter((r) => r.status === 'open');
    lines.push(`OPEN REQUESTS (${open.length}):`);
    for (const r of open) lines.push(`  ${r.id} [${r.kind}${r.blocking ? ', blocking' : ''}] from ${r.from} task ${r.taskId || '-'} age ${m(r.createdAt)} min — title: ${r.title}\n    detail: ${oneLine(r.detail, 400)}`);
    lines.push(this.flowDigest());
    if ((this.state.lessons || []).length) lines.push('LESSONS ALREADY SHARED WITH ALL TASKS:', ...this.state.lessons.map((l) => `  - ${oneLine(l.text, 200)} (from ${l.from})`));
    const pi = this.state.inspector;
    if (pi?.findings?.length || pi?.actions?.length) lines.push(`PREVIOUS INSPECTION (${pi.at}, ${pi.reason}): actions: ${(pi.actions || []).join(' / ') || 'none'}; findings: ${(pi.findings || []).map((f) => `${f.target}: ${oneLine(f.problem, 120)}`).join(' / ')}`);
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
        if (a.options?.length) { r.options = normOptions(a.options, a.recommended); r.recommended = r.options.find((o) => o.recommended)?.label || ''; }
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
        // ほかの task が待っている task（道を塞いでいる）は、15 分止まっていれば平均に関係なくやり直せる
        const blocking = this.state.epics.flatMap((e) => e.tasks).some((x) => x.status === 'todo' && (x.needs || []).includes(te.t.id));
        if ((stale >= 20 && ran >= 2 * avg) || (blocking && stale >= 15)) {
          (te.t.notes ||= []).push(String(a.text).slice(0, 600));
          te.t.abortReason = `点検役が止めてやり直し: ${oneLine(a.reason, 120)}`;
          this.ctrlByAgent?.get(te.t.agent)?.abort();
          done.push(`${te.t.id} を止めてやり直しに回した`);
        } else done.push(`${te.t.id} のやり直しは見送り（条件を満たさない）`);
      } else if (a.type === 'rewrite_text') {
        const field = a.title === 'brief' ? 'brief' : 'headline';
        if (te) { te.t[field] = oneLine(a.text, 120); done.push(`${te.t.id} の${field === 'brief' ? '説明' : '見出し'}を書き直した`); }
        else if (epics.get(a.target)) { epics.get(a.target).brief = oneLine(a.text, 120); done.push(`${a.target} の説明を書き直した`); }
      } else if (a.type === 'add_task') {
        const e = epics.get(a.target) || te?.e;
        const ws = [...new Set((a.paths || []).map(normPath).filter(Boolean))];
        const total = this.state.epics.reduce((n, x) => n + x.tasks.length, 0);
        if (!e || !a.title || !a.text || !ws.length) { done.push(`task の追加は見送り（epic・題名・説明・writeSet のどれかが無い）`); continue; }
        if (total >= this.cfg.maxTasks) { done.push(`task の追加は見送り（上限 ${this.cfg.maxTasks} 件）`); continue; }
        const n = e.tasks.filter((x) => /-I\d+$/.test(x.id)).length + 1;
        const nt = this.newTask({ id: `${e.id}-I${n}`, kind: 'coder', title: oneLine(a.title, 40), brief: oneLine(a.reason || a.title, 120), description: `${a.text}\n\n（点検役が追加した task。理由: ${a.reason || '-'}）`, writeSet: ws, risk: e.risk, needs: [] }, e);
        e.tasks.push(nt);
        if (e.status === 'done') e.status = 'running';
        for (const id of a.ids || []) {
          const w = tasks.get(id)?.t;
          if (w && !['done', 'dropped'].includes(w.status)) w.needs = [...new Set([...(w.needs || []), nt.id])];
        }
        done.push(`${nt.id}「${nt.title}」を追加した${(a.ids || []).length ? `（${a.ids.join(', ')} が待つ）` : ''}`);
      } else if (a.type === 'drop_need' && te) {
        const drop = new Set(a.ids || []);
        const before = te.t.needs || [];
        te.t.needs = before.filter((d) => !drop.has(d));
        if (te.t.needs.length !== before.length) done.push(`${te.t.id} の前提から ${[...drop].join(', ')} を外した（${oneLine(a.reason, 60)}）`);
      } else if (a.type === 'wake_task' && te && te.t.status === 'waiting') {
        te.t.wakeAt = new Date().toISOString();
        done.push(`${te.t.id} を今すぐ再開させた（${oneLine(a.reason, 60)}）`);
      } else if (a.type === 'share_lesson' && a.text) {
        if (this.addLesson(a.text, 'inspector')) done.push(`学びを全 task に共有した: ${oneLine(a.text, 60)}`);
      } else if (a.type === 'ask_human') {
        this.addRequests([{ kind: 'decision', blocking: false, title: oneLine(a.title, 80), detail: String(a.text).slice(0, 2000), options: a.options, recommended: a.recommended }], { from: 'inspector', taskId: tasks.has(a.target) ? a.target : null });
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

  // ---------- 重いキャッシュの使い回し（--warm-dirs） ----------
  // Unity の Library のような「作り直すと数十分かかるが、git の管理外で作り直せる」ものを、run ごとに温まった写しとして持つ。
  // 作業ツリーへはクローン（macOS は APFS の clonefile、Linux は reflink）で入れるので、一瞬で終わり、ディスクもほぼ使わない
  warmRoot() {
    return path.join(this.tmpBase(), `atv-${require('node:crypto').createHash('sha1').update(this.runId).digest('hex').slice(0, 6)}-warm`);
  }

  warmInto(wt) {
    for (const d of this.cfg.warmDirs || []) {
      const src = path.join(this.warmRoot(), d), dst = path.join(wt.path, d);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      if (cloneDir(src, dst)) this.log('start', `${path.basename(wt.path)}: 温まった ${d} をクローンで入れた`);
    }
  }

  warmFrom(wt) {
    for (const d of this.cfg.warmDirs || []) {
      const src = path.join(wt.path, d);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(this.warmRoot(), d), tmp = `${dst}.new-${process.pid}-${Date.now()}`;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (!cloneDir(src, tmp)) continue;
      // 入れ替えは rename で一度に（途中の状態を別の task がクローンしないように）
      const old = `${dst}.old-${Date.now()}`;
      try { if (fs.existsSync(dst)) fs.renameSync(dst, old); fs.renameSync(tmp, dst); } catch { fs.rmSync(tmp, { recursive: true, force: true }); }
      fs.rm(old, { recursive: true, force: true }, () => {});
    }
  }

  async relocateShared(wt, t, outside) {
    const moved = [];
    for (const dir of this.cfg.splitDirs || []) {
      const mine = `${dir}${t.id}/`;
      if (!t.writeSet.includes(mine)) continue;
      for (const f of outside) {
        if (!f.startsWith(dir) || f.startsWith(mine)) continue;
        const src = path.join(wt.path, f);
        if (!fs.existsSync(src)) continue; // 消しただけのものは動かせない（外の変更のまま）
        const dst = path.join(wt.path, mine, f.slice(dir.length));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        moved.push(f);
      }
    }
    if (moved.length) {
      // 移した元のファイルが以前からあったものなら、元に戻す（消したことにしない）
      for (const f of moved) {
        const r = require('node:child_process').spawnSync('git', ['-C', wt.path, 'cat-file', '-e', `${wt.base}:${f}`]);
        if (r.status === 0) require('node:child_process').spawnSync('git', ['-C', wt.path, 'checkout', wt.base, '--', f]);
      }
    }
    return moved;
  }

  // task ごとの一時フォルダ。worker の TMPDIR にして、そこに作られた一時コピーや残ったプロセスを task 単位で片付ける
  taskTmp(t) {
    // macOS の既定の TMPDIR（/var/folders/…/T/）の下に run の ID まで入れるとパスが長くなり、Unity のコンパイルが壊れた。
    // 短い /tmp の下に、run の ID を 6 桁のハッシュにして置く
    const dir = this.taskTmpPath(t);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  taskTmpPath(t) {
    return path.join(this.tmpBase(), `atv-${require('node:crypto').createHash('sha1').update(this.runId).digest('hex').slice(0, 6)}-${t.id}`);
  }

  // 共有の置き場所（--split-dirs）そのものを持つ writeSet は、task ごとのサブフォルダに置き換える（ロックをぶつけない）
  splitShared(id, writeSet) {
    const dirs = this.cfg.splitDirs || [];
    if (!dirs.length) return writeSet;
    return [...new Set(writeSet.map((w) => (dirs.includes(w.endsWith('/') ? w : `${w}/`) ? `${w.replace(/\/?$/, '/')}${id}/` : w)))];
  }

  newTask(t, epic) {
    return {
      id: String(t.id), title: t.title, brief: t.brief || '', headline: t.headline || '', description: t.description || '', status: 'todo', agent: null,
      kind: this.kindName(t.kind),
      writeSet: this.splitShared(String(t.id), [...new Set((t.writeSet || []).map(normPath).filter(Boolean))]),
      risk: t.risk ? normRisk(t.risk) : normRisk(epic.risk),
      needs: Array.isArray(t.needs) ? [...new Set(t.needs.map(String))] : null, // null = 中プロジェクトの dependsOn に従う
      tokens: 0, costUsd: 0, attempts: [], summary: '', activity: null, grants: [],
    };
  }

  // ---------- 2. スケジューラ（1 秒ごと + 状態変化時） ----------
  schedule() {
    const run = this.state.run;
    if (this.shuttingDown) return;
    if (!['running', 'paused', 'waiting-human', 'stuck', 'budget-stopped', 'plan-limit', 'protect-hold', 'mem-hold', 'done'].includes(run.status)) return;
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
    const canSpawn = () => !run.paused && !run.frozen && !run.planHold && !run.protectHold && !run.memHold && !run.diskHold && !run.draining && this.activeCount() < w.limits.maxActiveAgents;

    // 待ち時間が来た task を戻す
    for (const t of this.state.epics.flatMap((e) => e.tasks)) {
      if (t.status === 'waiting' && Date.now() >= Date.parse(t.wakeAt || 0)) { t.status = 'todo'; t.wakeAt = null; this.log('start', `${t.id}: 待ち時間が来たので再開`); }
    }
    this.checkStall();
    const doneIds = new Set(this.state.epics.filter((e) => e.status === 'done' || e.status === 'dropped').map((e) => e.id));
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
      if (e.tasks.every((t) => t.status === 'done' || t.status === 'dropped') && e.tasks.some((t) => t.status === 'done') && canSpawn()) this.runReview(e);
      else if (e.tasks.length && e.tasks.every((t) => t.status === 'dropped')) { e.status = 'dropped'; this.changed(); }
    }

    // 全体の状態（ループは止めない。依頼が解決されたり再開されたりしたら続きから動く）
    const busy = this.state.epics.some((e) => e.status === 'review' && e.review?.verdict === 'pending') ||
      this.state.epics.some((e) => e.tasks.some((t) => t.status === 'running' || t.status === 'critique' || t.status === 'waiting'));
    let next = 'running';
    if (this.state.epics.length && this.state.epics.every((e) => e.status === 'done' || e.status === 'dropped')) next = 'done';
    else if (!busy) {
      const startable = this.state.epics.some((e) => ['running', 'todo'].includes(e.status) && e.tasks.some((t) => t.status === 'todo' && ready(e, t)));
      if (run.frozen) next = 'budget-stopped';
      else if (run.planHold) next = 'plan-limit';
      else if (run.protectHold) next = 'protect-hold';
      else if (run.memHold) next = 'mem-hold';
      else if (run.diskHold) next = 'disk-hold';
      else if (run.paused && startable) next = 'paused';
      else if (this.state.epics.some((e) => e.tasks.some((t) => t.status === 'blocked'))) next = 'waiting-human';
      else if (!startable) next = 'stuck';
    }
    if (next !== run.status) {
      run.status = next;
      const msg = { done: 'プロジェクト完了。統合ブランチをレビューしてマージしてください', 'waiting-human': '人間への依頼待ちで止まっています（依頼パネルを確認）', stuck: '進められる task がありません（失敗した task / 差し戻し上限を確認）', 'budget-stopped': '予算上限で停止しました', 'plan-limit': `利用枠で停止中（${run.planHold?.reason || ''}）`, 'protect-hold': '保護パスの変更を検知して停止中（依頼パネルを確認）', 'mem-hold': 'メモリ不足で新規 spawn を停止中', 'disk-hold': 'ディスク不足で新規 spawn を停止中', paused: '一時停止中', running: '実行中' }[next];
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
    const ladder = this.ladderFor(kind, t);
    let route = policy.route(t.risk, failures, ladder, kind.floor);
    // 型が「作るものの種類ごとの effort」を持つなら、リスクではなく種類で最初の段を決める（失敗するたびに上げるのは同じ）
    const variant = effortFor(kind, t);
    if (variant) {
      const i = ladder.findIndex((x) => x.effort === variant.effort);
      if (i >= 0) route = ladder[Math.min(i + failures, ladder.length - 1)];
    }
    if (t.pinTop) route = ladder[ladder.length - 1]; // 中プロジェクトの引き継ぎは梯子の最上段
    if (!t.agent) t.agent = this.newAgent('worker', route);
    Object.assign(this.state.agents[t.agent], { runner: route.runner, model: route.model, effort: route.effort });
    const attempt = { model: route.model, effort: route.effort, runner: route.runner, result: 'running', startedAt: new Date().toISOString(), tokens: 0 };
    t.attempts.push(attempt);
    t.status = 'running'; // 同期的に running にしてロックを確保する
    this.state.agents[t.agent].state = 'active';
    this.log(failures ? 'escalate' : 'lock', `${t.id} [${kind.name}${variant ? `:${variant.name}` : ''}] 開始 ${route.model}/${route.effort}${failures ? `（${failures} 回失敗後に昇格）` : ''}。ロック: ${t.writeSet.join(', ') || '(なし)'}`);

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
      this.warmInto(wt); // 重いキャッシュ（Unity の Library など）を温まった写しからクローンで入れておく
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
        env: { ATV_TASK: taskTag(this.runId, t.id), TMPDIR: this.taskTmp(t), ...(this.cfg.warmDirs?.length ? { ATV_WARM: this.warmRoot() } : {}) },
        tools: [...kind.tools, ...t.grants], disallowed: GUARD.claudeDisallowed,
        replies: this.repliesFor(t.id),
        critique: this.critiqueFor(t),
        prompt: prompts.work({ goal: this.cfg.goal, task: t, epic: e, context: this.contextSummary(t), previous: this.previousEvidence(t), replies: this.repliesFor(t.id), critique: this.critiqueFor(t), kind, guard: `${GUARD.text}\n${this.protector.text()}`, note: (t.notes || []).slice(-2).join('\n'), lessons: this.lessonsText(), warm: this.cfg.warmDirs?.length ? this.cfg.warmDirs : null, sandbox: route.runner === 'codex' && this.cfg.codexSandbox !== 'danger-full-access' ? this.cfg.codexSandbox : null }),
        onActivity: (text) => { t.activity = text; },
      }, (d) => { t.tokens += d; attempt.tokens += d; });
      const granted = this.grantFromDenials(t, res.denials);
      // Codex の利用上限（spend cap など）なら失敗に数えず、上限の解放を人間に頼んで待つ
      if (!res.ok && route.runner === 'codex' && CODEX_CAP_RE.test(res.error || '')) {
        finish('blocked', `Codex の利用上限: ${oneLine(res.error, 300)}`);
        t.status = 'blocked';
        this.askCodexCap(e, t, res.error);
        return;
      }
      if (!res.ok) throw new Failure(res.error);
      t.costUsd += res.costUsd || 0;
      const out = res.output;
      for (const l of out.lessons || []) this.addLesson(l, t.id);

      // 権限が足りずに止まっただけなら、③ で広げて人間を煩わせずにやり直す
      if (out.status === 'blocked' && granted.length && (out.humanRequests || []).every((r) => r.kind === 'access')) {
        if ((await this.repo.commitAll(wt, `atv: ${t.id} (途中) ${t.title}`)).length) { wt.keep = true; t.carryBranch = wt.branch; }
        finish('blocked', `権限不足 → ${granted.join(', ')} を許可して再試行${t.carryBranch ? '（途中の変更は持ち込む）' : ''}`);
        t.status = 'todo';
        return;
      }
      // codex の sandbox（ネットワーク・ローカル IPC の遮断）で止まったなら、人間に曖昧な依頼を出さずに自分で対処する
      if (out.status === 'blocked' && this.sandboxBlocked(route, out)) {
        if ((await this.repo.commitAll(wt, `atv: ${t.id} (途中) ${t.title}`)).length) { wt.keep = true; t.carryBranch = wt.branch; }
        if (this.onSandboxBlock(e, t, kind, out)) {
          finish('blocked', `Codex の sandbox で止まった → Claude で再試行${t.carryBranch ? '（途中の変更は持ち込む）' : ''}: ${oneLine(out.summary, 200)}`);
          t.status = 'todo';
        } else {
          finish('blocked', out.summary);
          attempt.headline = out.headline || '';
          t.status = 'blocked';
        }
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
            options: [{ label: '続けて待つ', description: 'このまま待ちに戻す。ジョブが進んでいるならこれでよい' }, { label: 'やり方を変える', description: '返答欄に指示を書いてから選ぶ。その指示を添えてやり直す' }, { label: 'この task を諦める', description: '却下扱い。別の進め方で再開する' }],
            recommended: '続けて待つ',
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

      let changed = await this.repo.commitAll(wt, `atv: ${t.id} ${t.title}`);
      // 共有の置き場所（--split-dirs）の直下に書いたものは、失敗にせず task のサブフォルダへ移す
      // （計画や説明に古い置き場所が書いてあると、worker はそちらに書いてしまう）
      const moved = await this.relocateShared(wt, t, changed.filter((f) => !covered(f, t.writeSet)));
      if (moved.length) {
        changed = await this.repo.commitAll(wt, `atv: ${t.id} 共有の置き場所のファイルを ${t.id}/ に移す`).then(() => this.repo.changedSince(wt));
        this.log('warn', `${t.id}: 共有の置き場所の直下に書かれた ${moved.length} 件を ${t.id}/ に移した（${moved.slice(0, 3).join(', ')}）`);
      }
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
        this.warmInto(wt); // worker が消していても、検証の前に入れ直す
        const r = await shell(check, wt.path, this.cfg.checkTimeoutSec * 1000);
        if (!r.ok) throw new Failure(`検証コマンド失敗 (${check}):\n${r.tail}`);
        this.warmFrom(wt); // 通った作業ツリーのキャッシュを、次の task の温まった写しにする
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
      // この task が起動したまま残ったプロセス（nohup の Unity など）を止める。自分のジョブを待っているときだけ残す
      if (attempt.result !== 'waiting') {
        const patterns = [new RegExp(`${escRe(path.join(this.repo.dir, 'tasks', t.id))}-a\\d+(?=/|\\s|$)`), new RegExp(`${escRe(this.taskTmp(t))}(?=/|\\s|$)`)];
        const killed = await killTaskProcs(patterns).catch(() => []);
        if (killed.length) this.log('warn', `${t.id}: 試行のあとに残っていたプロセス ${killed.length} 本を止めた（${killed.slice(0, 3).map((k) => oneLine(k.cmd, 60)).join(' / ')}）`);
        // task が終わったら、その一時フォルダ（Unity の一時コピーなど。数 GB になる）も消す。やり直すならキャッシュとして残す
        if (['done', 'failed'].includes(t.status)) fs.rm(this.taskTmp(t), { recursive: true, force: true }, () => {});
      }
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
    // 上位モデルが引き継いだ中プロジェクトは、レビューも梯子の最上段が行う
    const route = e.takeovers ? this.ladder[this.ladder.length - 1] : policy.judge(this.ladder);
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
      } else if (e.reviewRounds >= this.cfg.maxReviewRounds && (e.takeovers || 0) < (this.cfg.takeoverRounds ?? 0)) {
        this.takeOver(e, out);
      } else if (e.reviewRounds >= this.cfg.maxReviewRounds) {
        e.review = { reviewer, verdict: 'needs-human', note: `差し戻し上限 (${this.cfg.maxReviewRounds} 回${e.takeovers ? `、上位モデルの引き継ぎ ${e.takeovers} 回` : ''})。${out.note}` };
        this.log('reject', `${e.id} 差し戻しが上限に達したため人間判断待ち`);
      } else {
        (e.reviewNotes ||= []).push(out.note);
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

  // ---------- 差し戻しが上限に達したとき: 梯子の最上段が中プロジェクトを丸ごと引き継ぐ ----------
  // 小さな修正 task を積み増す代わりに、これまでの指摘の履歴を全部渡して 1 つの task でまとめて直させる
  takeOver(e, out) {
    e.takeovers = (e.takeovers || 0) + 1;
    (e.reviewNotes ||= []).push(out.note);
    const top = this.ladder[this.ladder.length - 1];
    const writeSet = [...new Set([...out.fixes.flatMap((f) => f.writeSet || []), ...e.tasks.flatMap((t) => t.writeSet)])];
    const history = e.reviewNotes.map((n, i) => `${i + 1} 回目のレビュー: ${n}`).join('\n');
    const fixes = out.fixes.map((f) => `- ${f.title}: ${f.description}`).join('\n');
    const t = this.newTask({
      id: `${e.id}-TO${e.takeovers}`, kind: 'coder',
      title: `${e.title}を上位モデルが引き継いで仕上げる`,
      brief: 'レビューで何度も差し戻されたので、上位モデルがまとめて直す',
      description: `この中プロジェクト（${e.id} ${e.title}）は、レビューの差し戻しが上限（${this.cfg.maxReviewRounds} 回）に達した。小さな修正を重ねても通らなかったので、あなたが全体を引き継いで仕上げる。\n\nまず、なぜこれまでの修正で通らなかったのかを、レビューの指摘の履歴と実物（コード・生成物・スクリーンショット）から見極めること。同じ直し方を繰り返さず、必要なら作り方そのものを変えてよい（この中プロジェクトの writeSet の中で）。\n\nレビューの指摘の履歴:\n${history}\n\n最後のレビューが求めた修正:\n${fixes}`,
      writeSet, risk: { complexity: 1, uncertainty: 1, blast: 1 },
    }, e);
    t.pinTop = true;
    e.tasks.push(t);
    e.status = 'running';
    e.review = null;
    e.lastReviewNote = out.note;
    this.log('escalate', `${e.id} 差し戻しが上限に達した → ${top.model}/${top.effort} が引き継いで仕上げる（${e.takeovers}/${this.cfg.takeoverRounds} 回目）: ${oneLine(out.note)}`);
  }

  // ---------- Codex の利用上限に届いたとき ----------
  // 開いている上限の依頼が 1 件あれば、それに task を足す（上限が解放されるまで Codex の task は全部待つ）
  askCodexCap(e, t, error) {
    const open = this.state.requests.find((r) => r.status === 'open' && r.kind === 'limit');
    if (open) {
      if (!open.taskIds.includes(t.id)) open.taskIds.push(t.id);
      open.blocking = true;
      this.log('request', `${t.id} は人間待ち: Codex の利用上限（${open.id} に追加）`);
      return;
    }
    this.addRequests([{ kind: 'limit', blocking: true, title: 'Codex の利用上限に届いた',
      detail: `Codex がこう返しました: ${oneLine(error, 400)}\n\n上限を解放（ワークスペースの支出上限を上げる・リセットを待つなど）してから、この依頼に返答してください。止まっている Codex の task（画像生成など）が再開します。Codex を使わない task はこのまま進みます。` }],
    { from: t.agent, taskId: t.id, epicId: e.id });
    this.log('request', `${t.id} は人間待ち: Codex の利用上限`);
  }

  // ---------- codex の sandbox で止まったとき ----------
  sandboxBlocked(route, out) {
    if (route.runner !== 'codex' || this.cfg.codexSandbox === 'danger-full-access') return false;
    const reqs = out.humanRequests || [];
    if (reqs.some((r) => r.kind === 'sandbox')) return true;
    const text = [out.headline, out.summary, ...reqs.flatMap((r) => [r.title, r.detail])].join('\n');
    return SANDBOX_RE.test(text);
  }

  // Claude に回せたら true。回せない（型が codex 専用・梯子が codex だけ）なら、何を変えればよいかを書いた依頼を出して false
  onSandboxBlock(e, t, kind, out) {
    const run = this.state.run;
    const why = oneLine((out.humanRequests || []).map((r) => r.detail).filter(Boolean).join(' / ') || out.summary, 400);
    const widen = `Codex を sandbox なしで動かすには、\`.atv/${this.runId}/config.json\` の "args" に "--codex-sandbox", "danger-full-access" を足してから、ボードの「⟳ 再起動」（drain）を押してください。Codex の worker が確認なしで、この worktree の外やネットワークにも触れるようになります。`;
    const movable = kind.runner !== 'codex' && this.cfg.ladder !== 'codex';
    if (movable) {
      t.runnerPin = 'claude';
      this.log('escalate', `${t.id}: Codex の sandbox で止まったので Claude で再試行する（${oneLine(why, 120)}）`);
      if (!run.codexSandboxed) {
        run.codexSandboxed = true;
        this.addRequests([{ kind: 'sandbox', blocking: false, title: 'Codex の制限で動かない作業を Claude に回した',
          detail: `${t.id}「${t.title}」が Codex の sandbox（${this.cfg.codexSandbox}: ネットワークとローカル IPC を遮断）の中で止まりました: ${why}\n\nこの run では以後、どの runner でもよい型の task を Claude で動かします（対応は不要です）。\n${widen}` }],
        { from: t.agent, taskId: t.id, epicId: e.id });
      }
      return true;
    }
    this.addRequests([{ kind: 'sandbox', blocking: true, title: `${t.id}「${t.title}」が Codex の制限で止まった`,
      detail: `この型（${kind.name}）は Codex でしか動かないため、Claude に回せません。Codex の sandbox（${this.cfg.codexSandbox}）の中で止まった理由: ${why}\n\n${widen}\n再起動のあと、この依頼に返答すると再開します。${t.carryBranch ? `\n途中の変更はブランチ ${t.carryBranch} に残してあり、次の試行に持ち込みます。` : ''}` }],
    { from: t.agent, taskId: t.id, epicId: e.id });
    this.log('request', `${t.id} は人間待ち: Codex の sandbox で止まり、Claude にも回せない`);
    return false;
  }

  // ---------- 5. 人間への依頼 ----------
  addRequests(list, { from, taskId = null, epicId = null, taskIds = null }) {
    const added = [];
    for (const r of list || []) {
      // 同じ task から同じ依頼が繰り返されたら重ねない
      const dup = this.state.requests.find((x) => x.status === 'open' && x.taskId === taskId && x.title === r.title);
      if (dup) { added.push(dup); continue; }
      const ids = taskIds || (taskId ? [taskId] : []);
      const options = normOptions(r.options, r.recommended);
      const req = { id: `R${++this.reqSeq}`, kind: r.kind, title: r.title, detail: r.detail, options, recommended: options.find((o) => o.recommended)?.label || '', blocking: Boolean(r.blocking && ids.length), status: 'open', reply: '', from, taskId: ids[0] || null, taskIds: ids, epicId, createdAt: new Date().toISOString() };
      this.state.requests.push(req);
      added.push(req);
      this.log('request', `依頼 ${req.id} [${req.kind}] ${req.title}${req.blocking ? '（ブロッキング）' : ''}`);
      if (from !== 'inspector') this.inspectSoon('依頼が出た', 60000);
    }
    return added.filter((r) => r.blocking);
  }

  resolveRequest(id, { reply = '', dismiss = false, option = '' } = {}) {
    const r = this.state.requests.find((x) => x.id === id);
    if (!r) throw new Error(`依頼 ${id} が見つからない`);
    // 選択肢で答えたら、その内容を返答にする（自由記述があれば添える）
    if (option) {
      const o = (r.options || []).find((x) => x.label === option);
      r.choice = option;
      reply = `「${option}」を選択${o?.description ? `（${o.description}）` : ''}${reply ? `。補足: ${reply}` : ''}`;
      if (option === 'この task を諦める') dismiss = true;
      if (option === 'この計画で再開') setTimeout(() => this.control('resume'), 0);
      if (option === '直してほしい') setTimeout(() => this.replan(`前の立て直しへの指摘: ${reply}`).catch((e) => this.log('fail', e.message)), 0);
    }
    r.status = dismiss ? 'dismissed' : 'resolved';
    r.reply = String(reply).slice(0, 2000);
    r.resolvedAt = new Date().toISOString();
    // 人が判断に答えたのに、その task の今の試行は答えを知らない。止めて、答えを読んだ次の試行に切り替える（途中の変更は持ち込む）
    if (r.kind === 'decision' && !String(r.reply).startsWith('（点検役が回答）')) {
      for (const id of r.taskIds || [r.taskId]) {
        const t = this.state.epics.flatMap((e) => e.tasks).find((x) => x.id === id);
        if (t && t.status === 'running' && this.ctrlByAgent?.get(t.agent)) {
          t.abortReason = `人の判断（${r.id}）を反映するためにやり直し`;
          this.ctrlByAgent.get(t.agent).abort();
          this.log('control', `${t.id}: ${r.id} への答えを反映するため、今の試行を止めて次の試行に切り替える`);
        }
      }
    }
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
    } else if (action === 'retask') {
      // 人が task の今の試行を止め、注意書きを添えてやり直させる（途中の変更は持ち込む）
      const t = this.state.epics.flatMap((e) => e.tasks).find((x) => x.id === arg.taskId);
      if (!t) throw new Error(`task がない: ${arg.taskId}`);
      if (arg.note) (t.notes ||= []).push(`人からの指示: ${String(arg.note).slice(0, 1000)}`);
      if (t.status === 'running' && this.ctrlByAgent?.get(t.agent)) { t.abortReason = '人の指示でやり直し'; this.ctrlByAgent.get(t.agent).abort(); }
      else if (['failed', 'blocked', 'waiting'].includes(t.status)) { t.status = 'todo'; t.wakeAt = null; }
      this.log('control', `${t.id} を人の指示でやり直し${arg.note ? `: ${oneLine(arg.note, 100)}` : ''}`);
    } else if (action === 'replan') {
      this.replan(String(arg.reason || ''));
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

// ディレクトリを丸ごとクローンする（macOS: APFS clonefile、Linux: reflink。使えなければ普通のコピーはせずに false）
function cloneDir(src, dst) {
  const cp = require('node:child_process');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const args = process.platform === 'darwin' ? ['-cR', src, dst] : ['-a', '--reflink=always', src, dst];
  const r = cp.spawnSync('cp', args, { stdio: 'ignore' });
  if (r.status !== 0) { fs.rmSync(dst, { recursive: true, force: true }); return false; }
  return true;
}

// ---------- task が起動したプロセスの後始末 ----------
// Claude の Bash はコマンドごとに別のプロセスグループを作り、nohup したものは親が消えて孤児になる。
// そこで「その task の作業ツリーか一時フォルダのパスを引数に持つプロセス」を種にして、
// 同じプロセスグループと子孫まで広げて止める（macOS では他のプロセスの環境変数が読めないため）
const taskTag = (runId, taskId) => `${runId}/${taskId}`;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function procTable() {
  const txt = require('node:child_process').execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  return txt.split('\n').map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), cmd: m[4] }));
}

async function killTaskProcs(patterns) {
  const ps = procTable();
  const byPid = new Map(ps.map((p) => [p.pid, p]));
  // 自分（オーケストレータ）とその祖先は決して止めない
  const protect = new Set();
  for (let p = byPid.get(process.pid); p && !protect.has(p.pid); p = byPid.get(p.ppid)) protect.add(p.pid);
  const myPgid = byPid.get(process.pid)?.pgid;
  const seeds = ps.filter((p) => !protect.has(p.pid) && patterns.some((re) => re.test(p.cmd)));
  // プロセスグループに広げるのは、グループの頭がもう居ない（nohup で孤児になった）か、頭も種のときだけ。
  // 生きている別のシェル（人の端末など）のグループまで巻き込まないため
  const pgids = new Set(seeds.map((p) => p.pgid).filter((g) => g > 1 && g !== myPgid && !protect.has(g) && (!byPid.has(g) || seeds.some((s) => s.pid === g))));
  const hit = new Set(seeds.map((p) => p.pid));
  for (const p of ps) if (pgids.has(p.pgid)) hit.add(p.pid);
  for (let grew = true; grew;) { grew = false; for (const p of ps) if (!hit.has(p.pid) && hit.has(p.ppid)) { hit.add(p.pid); grew = true; } }
  const found = [...hit].filter((pid) => !protect.has(pid)).map((pid) => byPid.get(pid));
  for (const p of found) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* もう無い */ } }
  if (!found.length) return found;
  await new Promise((r) => setTimeout(r, 5000));
  for (const p of found) { try { process.kill(p.pid, 0); process.kill(p.pid, 'SIGKILL'); } catch { /* 止まった */ } }
  return found;
}

// 自分のプロセスをメモリの多い順に（macOS の ps には --sort がないので -m を使う）
function psByMemory() {
  const cp = require('node:child_process');
  const base = ['-u', String(process.getuid()), '-o', 'rss=,etime=,args='];
  const args = process.platform === 'darwin' ? ['-m', ...base] : [...base, '--sort=-rss'];
  return cp.execFileSync('ps', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// Codex の利用上限に届いたときのエラー文
const CODEX_CAP_RE = /spend cap|usage limit|usage_limit|rate limit|rate_limit|quota|insufficient_quota|limit (reached|exceeded)|hit your (\w+ )?limit|上限/i;

// codex の sandbox が原因らしい止まり方（worker が kind "sandbox" を付け忘れたときの拾い上げ）
const SANDBOX_RE = /EPERM|Operation not permitted|sandbox|サンドボックス|実行制限|ローカル ?IPC|network (access )?(is )?(disabled|blocked|denied)|ネットワーク(接続|アクセス)?[^。\n]{0,12}(遮断|禁止|許可|できない)/i;

// 依頼 r が task t を止めているか
const blocks = (r, t) => r.blocking && r.status === 'open' && (r.taskIds || [r.taskId]).includes(t.id);

// 選択肢: 推奨を先頭に、4 つまで
function normOptions(list, recommended) {
  const opts = (Array.isArray(list) ? list : []).map((o) => ({ label: oneLine(o?.label, 40), description: oneLine(o?.description, 200) })).filter((o) => o.label).slice(0, 4);
  const i = opts.findIndex((o) => o.label === oneLine(recommended, 40));
  if (i > 0) opts.unshift(...opts.splice(i, 1));
  return opts.map((o, k) => ({ ...o, recommended: k === 0 && i >= 0 }));
}

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
