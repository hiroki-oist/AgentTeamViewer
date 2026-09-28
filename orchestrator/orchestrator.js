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
        limits: { maxActiveAgents: cfg.maxAgents, maxAttemptsPerTask: cfg.maxAttempts, burnWarnPerMin: cfg.burnWarn, burnCritPerMin: cfg.burnCrit },
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

    this.minuteTimer = setInterval(() => { const b = this.state.watchdog.burn; b.push(0); b.shift(); this.changed(); }, 60000);
    this.tickTimer = setInterval(() => this.schedule(), 1000);

    await this.plan();
    this.schedule();
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
    for (const c of this.controllers) c.abort();
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, 10000))]);
  }

  // ---------- エージェント実行（共通） ----------
  async runAgent(agentId, opts, onTokens) {
    const a = this.state.agents[agentId];
    const ctrl = new AbortController();
    this.controllers.add(ctrl);
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
    }, this.cfg);
    // 最終値で途中経過を補正する
    const d = res.tokens - reported;
    this.addUsage(d, res.costUsd || 0);
    onTokens?.(d);
    this.controllers.delete(ctrl);
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
      prompt: prompts.plan({ goal: this.cfg.goal, checkCommand: this.cfg.check, maxTasks: this.cfg.maxTasks }),
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
    this.state.epics = this.validatePlan(p.epics || []);
    for (const e of this.state.epics) e.lead = root;
    const n = this.state.epics.reduce((s, e) => s + e.tasks.length, 0);
    this.state.run.status = 'running';
    this.log('plan', `計画完了: 中プロジェクト ${this.state.epics.length} 件 / task ${n} 件。検証コマンド: ${this.state.run.checkCommand || '(なし)'}`);
  }

  validatePlan(epics) {
    const ids = new Set(epics.map((e) => e.id));
    const out = epics.map((e) => ({
      id: String(e.id), title: e.title, status: 'todo', lead: null, review: null, reviewRounds: 0,
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
    return out;
  }

  newTask(t, epic) {
    return {
      id: String(t.id), title: t.title, description: t.description || '', status: 'todo', agent: null,
      writeSet: [...new Set((t.writeSet || []).map(normPath).filter(Boolean))],
      risk: t.risk ? normRisk(t.risk) : normRisk(epic.risk),
      tokens: 0, costUsd: 0, attempts: [], summary: '', activity: null,
    };
  }

  // ---------- 2. スケジューラ（1 秒ごと + 状態変化時） ----------
  schedule() {
    const run = this.state.run;
    if (this.shuttingDown) return;
    if (!['running', 'paused', 'waiting-human', 'stuck', 'budget-stopped', 'done'].includes(run.status)) return;
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
    const canSpawn = () => !run.paused && !run.frozen && this.activeCount() < w.limits.maxActiveAgents;

    const doneIds = new Set(this.state.epics.filter((e) => e.status === 'done').map((e) => e.id));
    for (const e of this.state.epics) {
      if (e.status === 'todo' && e.dependsOn.every((d) => doneIds.has(d)) && canSpawn()) {
        e.status = 'running';
        this.startEpic(e);
      }
      if (e.status !== 'running') continue;

      for (const t of e.tasks) {
        if (t.status !== 'todo' || !canSpawn()) continue;
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
      this.state.epics.some((e) => e.tasks.some((t) => t.status === 'running' || t.status === 'critique'));
    let next = 'running';
    if (this.state.epics.length && this.state.epics.every((e) => e.status === 'done')) next = 'done';
    else if (!busy) {
      const startable = this.state.epics.some((e) => (e.status === 'running' && e.tasks.some((t) => t.status === 'todo')) ||
        (e.status === 'todo' && e.dependsOn.every((d) => doneIds.has(d))));
      if (run.frozen) next = 'budget-stopped';
      else if (run.paused && startable) next = 'paused';
      else if (this.state.epics.some((e) => e.tasks.some((t) => t.status === 'blocked'))) next = 'waiting-human';
      else if (!startable) next = 'stuck';
    }
    if (next !== run.status) {
      run.status = next;
      const msg = { done: 'プロジェクト完了。統合ブランチをレビューしてマージしてください', 'waiting-human': '人間への依頼待ちで止まっています（依頼パネルを確認）', stuck: '進められる task がありません（失敗した task / 差し戻し上限を確認）', 'budget-stopped': '予算上限で停止しました', paused: '一時停止中', running: '実行中' }[next];
      this.log(next === 'done' ? 'done' : 'watchdog', msg);
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
    const route = policy.route(t.risk, failures, this.ladder);
    if (!t.agent) t.agent = this.newAgent('worker', route);
    Object.assign(this.state.agents[t.agent], { runner: route.runner, model: route.model, effort: route.effort });
    const attempt = { model: route.model, effort: route.effort, runner: route.runner, result: 'running', startedAt: new Date().toISOString(), tokens: 0 };
    t.attempts.push(attempt);
    t.status = 'running'; // 同期的に running にしてロックを確保する
    this.state.agents[t.agent].state = 'active';
    this.log(failures ? 'escalate' : 'lock', `${t.id} 開始 ${route.model}/${route.effort}${failures ? `（${failures} 回失敗後に昇格）` : ''}。ロック: ${t.writeSet.join(', ') || '(なし)'}`);

    let wt = null;
    let needCritic = false;
    const finish = (result, note) => {
      attempt.result = result;
      attempt.note = note;
      attempt.endedAt = new Date().toISOString();
      t.activity = null;
    };
    try {
      wt = await this.repo.createTaskWorktree(t.id, t.attempts.length);
      const res = await this.runAgent(t.agent, {
        role: 'worker', cwd: wt.path, schema: SCHEMAS.work, task: t,
        replies: this.repliesFor(t.id),
        critique: this.critiqueFor(t),
        prompt: prompts.work({ goal: this.cfg.goal, task: t, epic: e, context: this.contextSummary(t), previous: this.previousEvidence(t), replies: this.repliesFor(t.id), critique: this.critiqueFor(t) }),
        onActivity: (text) => { t.activity = text; },
      }, (d) => { t.tokens += d; attempt.tokens += d; });
      if (!res.ok) throw new Failure(res.error);
      t.costUsd += res.costUsd || 0;
      const out = res.output;
      const blocking = this.addRequests(out.humanRequests, { from: t.agent, taskId: t.id, epicId: e.id });

      if (out.status === 'blocked' || blocking.length) {
        finish('blocked', out.summary);
        t.status = 'blocked';
        this.log('request', `${t.id} は人間待ち: ${blocking.map((r) => r.title).join(' / ') || out.summary}`);
        return;
      }
      if (out.status === 'gave_up') throw new Failure(`エージェントが断念: ${out.summary}`);

      const changed = await this.repo.commitAll(wt, `atv: ${t.id} ${t.title}`);
      const outside = changed.filter((f) => !covered(f, t.writeSet));
      if (outside.length) throw new Failure(`writeSet 外を変更: ${outside.slice(0, 5).join(', ')}`);
      if (!changed.length && t.writeSet.length) throw new Failure(`変更がない（summary: ${out.summary}）`);

      const check = this.state.run.checkCommand;
      if (check && changed.length) {
        t.activity = `検証中: ${check}`;
        this.changed();
        const r = await shell(check, wt.path, this.cfg.checkTimeoutSec * 1000);
        if (!r.ok) throw new Failure(`検証コマンド失敗 (${check}):\n${r.tail}`);
      }
      if (changed.length) await this.repo.merge(wt.branch, `atv: merge ${t.id} ${t.title}`);

      finish('ok');
      t.summary = out.summary;
      t.status = 'done';
      this.state.agents[t.agent].state = 'finished';
      this.log('done', `${t.id} 完了（${changed.length} ファイル）。ロック解放。${oneLine(out.summary)}`);
    } catch (err) {
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
      }
    } finally {
      if (wt) await this.repo.removeWorktree(wt);
      this.changed();
      if (needCritic && !this.shuttingDown) await this.runCritic(e, t);
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
        prompt: prompts.critique({ goal: this.cfg.goal, task: t, epic: e, attempts, context: this.contextSummary(t), earlier }),
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
          this.log('critic', `${t.id} を定義し直し: ${t.title}（writeSet ${before || '(なし)'} → ${t.writeSet.join(', ') || '(なし)'}）`);
        }
        t.status = this.state.requests.some((x) => x.taskId === t.id && x.blocking && x.status === 'open') ? 'blocked' : 'todo';
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

  // 後続 task に渡す共有メモリ。完了 task の要約だけ（トークン節約のため 1 行ずつ）
  contextSummary(except) {
    const lines = this.state.epics.flatMap((e) => e.tasks)
      .filter((t) => t.status === 'done' && t !== except && t.summary)
      .slice(-15).map((t) => `- ${t.id} ${t.title}: ${oneLine(t.summary, 200)}`);
    return lines.join('\n');
  }

  previousEvidence(t) {
    const last = [...t.attempts].reverse().find((a) => a.result === 'fail');
    return last ? `(${last.model}/${last.effort}) ${last.note}` : '';
  }

  repliesFor(taskId) {
    return this.state.requests.filter((r) => r.taskId === taskId && r.status !== 'open')
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
        prompt: prompts.review({ goal: this.cfg.goal, epic: e, diff, checkCommand: this.state.run.checkCommand }),
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
        out.fixes.forEach((f, i) => e.tasks.push(this.newTask({ ...f, id: `${e.id}-F${e.reviewRounds}${String.fromCharCode(97 + i)}`, risk: e.risk }, e)));
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
  addRequests(list, { from, taskId = null, epicId = null }) {
    const added = [];
    for (const r of list || []) {
      // 同じ task から同じ依頼が繰り返されたら重ねない
      const dup = this.state.requests.find((x) => x.status === 'open' && x.taskId === taskId && x.title === r.title);
      if (dup) { added.push(dup); continue; }
      const req = { id: `R${++this.reqSeq}`, kind: r.kind, title: r.title, detail: r.detail, blocking: Boolean(r.blocking && taskId), status: 'open', reply: '', from, taskId, epicId, createdAt: new Date().toISOString() };
      this.state.requests.push(req);
      added.push(req);
      this.log('request', `依頼 ${req.id} [${req.kind}] ${req.title}${req.blocking ? '（ブロッキング）' : ''}`);
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
      if (t.status === 'blocked' && !this.state.requests.some((x) => x.taskId === t.id && x.blocking && x.status === 'open')) {
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
