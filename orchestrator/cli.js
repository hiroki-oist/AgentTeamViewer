#!/usr/bin/env node
// 使い方:
//   node orchestrator/cli.js --repo ../my-project --goal "LIBERO-CTRL を実装して…"
//   node orchestrator/cli.js --repo ../my-project --goal-file goal.md --ladder mixed --check "pytest -q"
//   node orchestrator/cli.js --repo /tmp/sandbox --goal "試し" --ladder mock     # CLI を呼ばずに試す
const path = require('node:path');
const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { execFileSync } = require('node:child_process');
const { Orchestrator } = require('./orchestrator.js');
const { serve } = require('./server.js');
const tailscale = require('./tailscale.js');

const { values: v } = parseArgs({
  options: {
    repo: { type: 'string' },
    goal: { type: 'string' },
    'goal-file': { type: 'string' },
    ladder: { type: 'string', default: 'claude' },
    check: { type: 'string', default: '' },
    port: { type: 'string', default: '8000' },
    'budget-tokens': { type: 'string', default: '3000000' },
    'budget-usd': { type: 'string', default: '30' },
    'per-call-usd': { type: 'string', default: '5' },
    'max-agents': { type: 'string', default: '4' },
    'max-attempts': { type: 'string', default: '4' },
    'critic-after': { type: 'string', default: '2' },
    'max-tasks': { type: 'string', default: '20' },
    'max-review-rounds': { type: 'string', default: '2' },
    'check-timeout': { type: 'string', default: '1200' },
    'claude-permission-mode': { type: 'string', default: 'acceptEdits' },
    'worker-tools': { type: 'string', default: 'Bash' },
    'codex-sandbox': { type: 'string', default: 'workspace-write' },
    'codex-model': { type: 'string', default: '' },
    paused: { type: 'boolean', default: false },
    tailscale: { type: 'boolean', default: false },
    'run-id': { type: 'string', default: '' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (v.help || !v.repo || !(v.goal || v['goal-file'])) {
  console.log(`Agent Team Viewer オーケストレータ

必須:
  --repo <path>           対象の git リポジトリ（作業は .atv/<runId>/ の worktree で行い、元の作業ツリーには触れない）
  --goal <text> | --goal-file <file>

主なオプション:
  --ladder claude|codex|mixed|mock   推論の重さの梯子（既定 claude。mock は CLI を呼ばない試運転）
  --check "<cmd>"         各 task の後に走らせる検証コマンド（省略時は root が提案）
  --budget-tokens N       トークン予算（既定 3000000）。90% で新規 spawn を止める
  --budget-usd N          コスト予算 USD（既定 30。codex はコストを返さないためトークンで管理）
  --per-call-usd N        claude 1 回あたりの上限 USD（既定 5）
  --max-agents N          同時稼働数（既定 4）
  --max-attempts N        task ごとの試行上限（既定 4。失敗ごとに梯子を 1 段上げる）
  --critic-after N        N 回失敗した task に critic（批判的レビュー）を立てる（既定 2。0 で無効）
  --claude-permission-mode acceptEdits|bypassPermissions  worker の権限（既定 acceptEdits = worktree 内の編集を許可）
  --worker-tools "<list>"  worker に追加で許可するツール（既定 "Bash"。例: "Bash(python3:*),Bash(pytest:*)" で絞る）
  --codex-sandbox workspace-write|danger-full-access            worker の sandbox（既定 workspace-write）
  --paused                計画だけ立てて一時停止状態で待つ（ボードで ▶ 再開）
  --tailscale             ボードを tailnet 内の他の端末にも公開する（tailscale serve。終了時に解除）
  --port N                ボードのポート（既定 8000。使用中なら次の番号を使う）
  --run-id <id>           run の ID（既定は日時）。接続先は <repo>/.atv/<id>/server.json に書き出す`);
  process.exit(v.help ? 0 : 1);
}

const num = (k) => Number(v[k]);
const cfg = {
  repo: path.resolve(v.repo),
  goal: v.goal || fs.readFileSync(v['goal-file'], 'utf8').trim(),
  ladder: v.ladder,
  check: v.check,
  budgetTokens: num('budget-tokens'),
  budgetUsd: num('budget-usd'),
  perCallUsd: num('per-call-usd'),
  maxAgents: num('max-agents'),
  maxAttempts: num('max-attempts'),
  criticAfter: num('critic-after'),
  maxTasks: num('max-tasks'),
  maxReviewRounds: num('max-review-rounds'),
  checkTimeoutSec: num('check-timeout'),
  burnWarn: 25000,
  burnCrit: 45000,
  startPaused: v.paused,
  runId: v['run-id'],
  claudePermissionMode: v['claude-permission-mode'],
  workerTools: v['worker-tools'],
  codexSandbox: v['codex-sandbox'],
  codexModel: v['codex-model'],
  claudeBin: process.env.ATV_CLAUDE_BIN || 'claude',
  codexBin: process.env.ATV_CODEX_BIN || 'codex',
};

(async () => {
  const orch = new Orchestrator(cfg);
  // ポートが使用中なら次の番号を試す
  let port = num('port');
  for (;;) {
    try { await serve(orch, { port }); break; } catch (err) {
      if (err.code !== 'EADDRINUSE' || port >= num('port') + 20) { console.error(err.message); process.exit(1); }
      port++;
    }
  }
  const url = `http://127.0.0.1:${port}/`;
  console.log(`ボード: ${url}`);

  let shared = null;
  if (v.tailscale) {
    shared = await tailscale.share(port);
    if (shared.url) {
      orch.state.run.shareUrl = shared.url;
      console.log(`tailnet 内の他の端末から: ${shared.url}`);
    } else {
      console.error(`tailnet への公開に失敗: ${shared.error}`);
      // 起動は続け、あとで対応できるよう依頼として残す
      orch.addRequests([{
        kind: 'access', blocking: false, title: 'ボードを tailnet に公開できなかった',
        detail: shared.enableUrl ? `Tailscale Serve が tailnet で無効です。${shared.enableUrl} を開いて有効にしてから、オーケストレータを --tailscale 付きで起動し直してください。` : shared.error,
      }], { from: 'watchdog' });
      shared = null;
    }
  }
  // skill などの外部から接続先を見つけられるようにする
  try {
    const root = execFileSync('git', ['-C', cfg.repo, 'rev-parse', '--show-toplevel']).toString().trim();
    const dir = path.join(root, '.atv', orch.runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ runId: orch.runId, pid: process.pid, port, url, tailnetUrl: shared?.url || null }, null, 1));
  } catch { /* git repo でなければ start() がエラーを出す */ }

  const stop = async () => {
    console.log('\n停止します（実行中のエージェントを中断し、worktree を片付け中）');
    await orch.shutdown();
    if (shared) await shared.off();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    await orch.start();
  } catch (err) {
    orch.state.run.status = 'failed';
    orch.log('fail', `起動に失敗: ${err.message}`);
  }
})();
