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
    ladder: { type: 'string', default: 'auto' },
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
    'plan-week-warn': { type: 'string', default: '0.8' },
    'plan-week-stop': { type: 'string', default: '0.9' },
    'plan-5h-stop': { type: 'string', default: '0.95' },
    'plan-week-share': { type: 'string', default: '0' },
    'plan-probe-min': { type: 'string', default: '15' },
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
  --ladder auto|claude|codex|mixed|mock   推論の重さの梯子（既定 auto = Codex が使える環境なら混ぜる。mock は CLI を呼ばない試運転）
  --check "<cmd>"         各 task の後に走らせる検証コマンド（省略時は root が提案）
  --budget-tokens N       トークン予算（既定 3000000）。90% で新規 spawn を止める
  --budget-usd N          コスト予算 USD（既定 30。codex はコストを返さないためトークンで管理）
  --per-call-usd N        claude 1 回あたりの上限 USD（既定 5）
  --max-agents N          同時稼働数（既定 4）
  --max-attempts N        task ごとの試行上限（既定 4。失敗ごとに梯子を 1 段上げる）
  --critic-after N        N 回失敗した task に critic（批判的レビュー）を立てる（既定 2。0 で無効）
  --plan-week-warn R      プランの週の枠の使用率が R を超えたら警告（既定 0.8）
  --plan-week-stop R      週の枠が R を超えたら新規 spawn を止め、リセット時刻に自動再開（既定 0.9。0 で無効）
  --plan-5h-stop R        5 時間枠が R を超えたら同様に止める（既定 0.95。0 で無効）
  --plan-week-share R     この run が週の枠を R ぶん（例 0.3 = 30 ポイント）使ったら止める（既定 0 = 無効）
  --plan-probe-min N      エージェントが動いていないとき、N 分ごとに枠を確かめる（既定 15。haiku を 1 回呼ぶ）
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

// 使える runner を調べる。codex はログイン済みのときだけ使える扱いにする
const works = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 15000 }); return true; } catch { return false; } };
const claudeBin = process.env.ATV_CLAUDE_BIN || 'claude';
const codexBin = process.env.ATV_CODEX_BIN || 'codex';
const available = { claude: works(claudeBin, ['--version']), codex: works(codexBin, ['login', 'status']) };
const ladder = v.ladder !== 'auto' ? v.ladder : available.claude && available.codex ? 'mixed' : available.codex ? 'codex' : 'claude';
const cfg = {
  repo: path.resolve(v.repo),
  goal: v.goal || fs.readFileSync(v['goal-file'], 'utf8').trim(),
  ladder,
  available,
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
  planWeekWarn: num('plan-week-warn'),
  planWeekStop: num('plan-week-stop'),
  planFiveHourStop: num('plan-5h-stop'),
  planWeekShare: num('plan-week-share'),
  planProbeMin: num('plan-probe-min'),
  burnWarn: 25000,
  burnCrit: 45000,
  startPaused: v.paused,
  runId: v['run-id'],
  claudePermissionMode: v['claude-permission-mode'],
  workerTools: v['worker-tools'],
  codexSandbox: v['codex-sandbox'],
  codexModel: v['codex-model'],
  claudeBin,
  codexBin,
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
  console.log(`runner: claude ${available.claude ? '○' : '×'} / codex ${available.codex ? '○' : '×'} → 梯子 ${ladder}`);

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
