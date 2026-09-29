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

// --resume のときは、前回の起動時の引数（.atv/<runId>/config.json）を土台にし、今回の引数で上書きする。
//   atv --repo <repo> --run-id <id> --resume だけで、同じ設定・最新版のコードで続きから立ち上がる
const argvNow = process.argv.slice(2);
const argOf = (name) => { const i = argvNow.indexOf(name); return i >= 0 ? argvNow[i + 1] : null; };
const RESTART_DROP = new Set(['--resume', '--paused']);
const dropFlags = (args) => args.filter((a) => !RESTART_DROP.has(a));
let savedArgs = [];
if (argvNow.includes('--resume') && argOf('--repo') && argOf('--run-id')) {
  try {
    const root = execFileSync('git', ['-C', path.resolve(argOf('--repo')), 'rev-parse', '--show-toplevel']).toString().trim();
    savedArgs = JSON.parse(fs.readFileSync(path.join(root, '.atv', argOf('--run-id'), 'config.json'), 'utf8')).args || [];
  } catch { /* 保存がなければ今回の引数だけで動く */ }
}
const argv = [...dropFlags(savedArgs), ...argvNow];

const { values: v } = parseArgs({
  args: argv,
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
    'max-waits': { type: 'string', default: '12' },
    'inspect-min': { type: 'string', default: '15' },
    'mem-min-gb': { type: 'string', default: '8' },
    'critic-after': { type: 'string', default: '2' },
    'max-tasks': { type: 'string', default: '20' },
    'max-review-rounds': { type: 'string', default: '2' },
    'takeover-rounds': { type: 'string', default: '2' },
    'check-timeout': { type: 'string', default: '1200' },
    'plan-week-warn': { type: 'string', default: '0.8' },
    'plan-week-stop': { type: 'string', default: '0.9' },
    'plan-5h-stop': { type: 'string', default: '0.95' },
    'plan-week-share': { type: 'string', default: '0' },
    'plan-probe-min': { type: 'string', default: '15' },
    protect: { type: 'string', default: '' },
    bwrap: { type: 'string', default: 'auto' },
    'burn-warn': { type: 'string', default: '' },
    'burn-crit': { type: 'string', default: '' },
    'claude-permission-mode': { type: 'string', default: 'acceptEdits' },
    'worker-tools': { type: 'string', default: 'Bash' },
    'codex-sandbox': { type: 'string', default: 'workspace-write' },
    'codex-model': { type: 'string', default: '' },
    paused: { type: 'boolean', default: false },
    resume: { type: 'boolean', default: false },
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
  --max-review-rounds N   中プロジェクトのレビューで差し戻せる回数（既定 2）
  --takeover-rounds N     差し戻しが上限に達した中プロジェクトを、梯子の最上段が丸ごと引き継いで直す回数（既定 2。0 で無効 = すぐ人間判断待ち）
  --plan-week-warn R      プランの週の枠の使用率が R を超えたら警告（既定 0.8）
  --plan-week-stop R      週の枠が R を超えたら新規 spawn を止め、リセット時刻に自動再開（既定 0.9。0 で無効）
  --plan-5h-stop R        5 時間枠が R を超えたら同様に止める（既定 0.95。0 で無効）
  --plan-week-share R     この run が週の枠を R ぶん（例 0.3 = 30 ポイント）使ったら止める（既定 0 = 無効）
  --plan-probe-min N      エージェントが動いていないとき、N 分ごとに枠を確かめる（既定 15。haiku を 1 回呼ぶ）
  --protect "<dir>,<dir>" 元の作業ツリーに加えて、エージェントに書かせないディレクトリ（読むのはよい）
  --bwrap auto|off        auto: bwrap が使えれば保護パスを読み取り専用にして動かす（使えなければ変化の監視だけ）
  --burn-warn N / --burn-crit N  消費速度の警告 tok/min（既定 同時数 × 25k / × 45k。表示だけで止めはしない）
  --claude-permission-mode acceptEdits|bypassPermissions  worker の権限（既定 acceptEdits = worktree 内の編集を許可）
  --worker-tools "<list>"  worker に追加で許可するツール（既定 "Bash"。例: "Bash(python3:*),Bash(pytest:*)" で絞る）
  --codex-sandbox workspace-write|danger-full-access            worker の sandbox（既定 workspace-write）
  --paused                計画だけ立てて一時停止状態で待つ（ボードで ▶ 再開）
  --resume                同じ --run-id の .atv/<runId>/state.json から続きを始める（計画し直さない。統合ブランチもそのまま使う）
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
  maxWaits: num('max-waits'),
  inspectMin: num('inspect-min'),
  memMinGb: num('mem-min-gb'),
  criticAfter: num('critic-after'),
  maxTasks: num('max-tasks'),
  maxReviewRounds: num('max-review-rounds'),
  takeoverRounds: num('takeover-rounds'),
  checkTimeoutSec: num('check-timeout'),
  planWeekWarn: num('plan-week-warn'),
  planWeekStop: num('plan-week-stop'),
  planFiveHourStop: num('plan-5h-stop'),
  planWeekShare: num('plan-week-share'),
  planProbeMin: num('plan-probe-min'),
  burnWarn: num('burn-warn') || 25000 * num('max-agents'),
  burnCrit: num('burn-crit') || 45000 * num('max-agents'),
  protect: v.protect.split(',').map((x) => x.trim().replace(/^~(?=\/|$)/, process.env.HOME)).filter(Boolean),
  bwrap: v.bwrap,
  startPaused: v.paused,
  resume: v.resume,
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
  let server = null;
  for (;;) {
    try { server = await serve(orch, { port }); break; } catch (err) {
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
    // 再起動（--resume）で同じ設定を使えるよう、起動時の引数を残す。run-id は必ず固定する
    const keep = dropFlags(argv);
    if (!keep.includes('--run-id')) keep.push('--run-id', orch.runId);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ args: keep, savedAt: new Date().toISOString() }, null, 1));
    orch.logPath = path.join(dir, 'orchestrator.log');
    orch.configArgs = keep;
  } catch { /* git repo でなければ start() がエラーを出す */ }

  const stop = async () => {
    console.log('\n停止します（実行中のエージェントを中断し、worktree を片付け中）');
    await orch.shutdown();
    orch.persistNow(); // 中断した task（と持ち込む途中の変更）の状態を残してから抜ける
    if (shared) await shared.off();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // 安全な再起動: 新規 spawn を止め、（drain なら）実行中の agent を最後まで走らせてから状態を保存し、
  // 最新版のコードで同じ引数 + --resume の新しいプロセスを立ち上げてから抜ける
  orch.on('restart', async ({ mode }) => {
    if (mode === 'drain') {
      while (orch.activeCount() > 0 || orch.inflight.size > 0) await new Promise((r) => setTimeout(r, 2000));
    }
    orch.log('control', `再起動します（${mode === 'drain' ? '実行中の agent の完了後' : '実行中の agent を中断'}）。最新版のコードで --resume`);
    await orch.shutdown();
    orch.persistNow();
    if (shared) await shared.off();
    // ボードの SSE 接続が開いたままだと close が終わらないので、先に全部切る（ブラウザは自動で繋ぎ直す）
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    const out = fs.openSync(orch.logPath || '/dev/null', 'a');
    const child = require('node:child_process').spawn(process.execPath, [__filename, ...(orch.configArgs || dropFlags(argv)), '--resume'], { detached: true, stdio: ['ignore', out, out], cwd: process.cwd(), env: process.env });
    child.unref();
    console.log(`新しいプロセス ${child.pid} に引き継ぎました`);
    process.exit(0);
  });

  try {
    await orch.start();
  } catch (err) {
    orch.state.run.status = 'failed';
    orch.log('fail', `起動に失敗: ${err.message}`);
  }
})();
