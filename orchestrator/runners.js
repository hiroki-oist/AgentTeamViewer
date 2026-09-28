// エージェント実行のアダプタ。どの runner も同じ形で呼べる:
//   run({ role, cwd, prompt, schema, model, effort, readOnly, maxBudgetUsd, task, onUsage, onActivity, onRateLimit, signal })
//     → { ok, output, tokens, costUsd, error }
// onUsage(tokensSoFar) は途中経過（累計）、onActivity(text) は「いま何をしているか」の 1 行。
// onRateLimit(info) はプランの利用枠（5 時間枠・週の枠の使用率）。claude だけが返す。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const oneLine = (s, n = 100) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// 子プロセスを起動し、stdout を 1 行ずつ JSON として渡す
// protector があれば、保護パスを読み取り専用にした名前空間で起動する（orchestrator/protect.js）
function runJsonl(cmd0, args0, { cwd, input, signal, onLine, protector }) {
  const [cmd, args] = protector ? protector.wrap(cmd0, args0, cwd) : [cmd0, args0];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let buf = '', stderr = '';
    const kill = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { onLine(JSON.parse(line)); } catch { /* JSON 以外の行は無視 */ }
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => resolve({ code: -1, stderr: e.message }));
    child.on('close', (code) => { signal?.removeEventListener('abort', kill); resolve({ code, stderr, aborted: signal?.aborted }); });
    child.stdin.end(input);
  });
}

// ---------- Claude Code (claude -p) ----------
function describeTool(b) {
  const i = b.input || {};
  const arg = i.command || i.file_path || i.pattern || i.path || i.description || '';
  return `${b.name} ${oneLine(arg, 80)}`.trim();
}

async function claude(opts, cfg) {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--model', opts.model, '--effort', opts.effort,
    '--json-schema', JSON.stringify(opts.schema),
  ];
  if (opts.readOnly) args.push('--permission-mode', 'dontAsk', '--allowedTools', 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(ls:*)');
  else {
    args.push('--permission-mode', cfg.claudePermissionMode);
    // ② 型のツール + ③ その場で許可したもの。① の安全柵は disallowed で常に上書きする
    const allowed = [...new Set([...(cfg.workerTools ? cfg.workerTools.split(',') : []), ...(opts.tools || [])].map((x) => x.trim()).filter(Boolean))];
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
    if (opts.disallowed?.length) args.push('--disallowedTools', opts.disallowed.join(','));
  }
  if (opts.maxBudgetUsd > 0) args.push('--max-budget-usd', opts.maxBudgetUsd.toFixed(2));

  const perMessage = new Map();
  let final = null;
  const r = await runJsonl(cfg.claudeBin, args, {
    cwd: opts.cwd, input: opts.prompt, signal: opts.signal, protector: cfg.protector,
    onLine: (ev) => {
      if (ev.type === 'assistant' && ev.message) {
        const u = ev.message.usage;
        if (u) perMessage.set(ev.message.id, (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0));
        opts.onUsage?.([...perMessage.values()].reduce((a, b) => a + b, 0));
        for (const b of ev.message.content || []) {
          if (b.type === 'tool_use' && b.name !== 'StructuredOutput') opts.onActivity?.(describeTool(b));
          else if (b.type === 'text' && b.text.trim()) opts.onActivity?.(oneLine(b.text));
        }
      } else if (ev.type === 'rate_limit_event') opts.onRateLimit?.(ev.rate_limit_info);
      else if (ev.type === 'result') final = ev;
    },
  });

  if (!final) return { ok: false, tokens: sum(perMessage), costUsd: 0, error: r.aborted ? '中断' : `claude が結果を返さずに終了 (code ${r.code}): ${oneLine(r.stderr, 300)}` };
  // 最終集計はサブエージェント分も含む modelUsage を使う（キャッシュ読み込みは数えない）
  const tokens = Object.values(final.modelUsage || {}).reduce((a, m) => a + (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheCreationInputTokens || 0), 0) || sum(perMessage);
  const costUsd = final.total_cost_usd || 0;
  // 権限で拒否された操作は、次の試行の証拠として残す
  const denials = (final.permission_denials || []).map((d) => ({ tool: d.tool_name, command: d.tool_input?.command || d.tool_input?.file_path || '' }));
  const denied = denials.map((d) => `${d.tool} ${oneLine(d.command, 60)}`);
  if (denied.length && final.structured_output) final.structured_output.summary = `${final.structured_output.summary}（権限で拒否: ${denied.slice(0, 3).join(' / ')}）`;
  const modelUsage = final.modelUsage || {};
  if (final.is_error || !final.structured_output) return { ok: false, tokens, costUsd, denials, modelUsage, error: `claude: ${final.subtype} ${oneLine(final.result, 300)}` };
  return { ok: true, output: final.structured_output, tokens, costUsd, denials, modelUsage };
}

const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);

// プランの利用枠だけを知りたいときの最小の呼び出し（haiku に 1 語返させる。数セント）
async function probeRateLimit(cfg) {
  let info = null, cost = 0;
  await runJsonl(cfg.claudeBin, ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', 'haiku', '--max-budget-usd', '0.10'], {
    cwd: os.tmpdir(), input: 'Reply with just: ok',
    onLine: (ev) => { if (ev.type === 'rate_limit_event') info = ev.rate_limit_info; else if (ev.type === 'result') cost = ev.total_cost_usd || 0; },
  });
  if (info) info.probeCostUsd = cost;
  return info;
}

// ---------- Codex (codex exec) ----------
async function codex(opts, cfg) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atv-codex-'));
  const schemaFile = path.join(tmp, 'schema.json');
  const lastFile = path.join(tmp, 'last.json');
  fs.writeFileSync(schemaFile, JSON.stringify(opts.schema));
  const args = [
    'exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', opts.cwd,
    '-s', opts.readOnly ? 'read-only' : cfg.codexSandbox,
    '-c', `model_reasoning_effort="${opts.effort}"`,
    '--output-schema', schemaFile, '-o', lastFile,
  ];
  if (cfg.codexModel) args.push('-m', cfg.codexModel);
  args.push('-');

  let tokens = 0, lastError = '';
  const r = await runJsonl(cfg.codexBin, args, {
    cwd: opts.cwd, input: opts.prompt, signal: opts.signal, protector: cfg.protector,
    onLine: (ev) => {
      if (ev.type === 'turn.completed' && ev.usage) {
        // input_tokens はキャッシュ分を含むので差し引く
        tokens += (ev.usage.input_tokens || 0) - (ev.usage.cached_input_tokens || 0) + (ev.usage.output_tokens || 0);
        opts.onUsage?.(tokens);
      } else if (ev.type === 'item.started' || ev.type === 'item.completed') {
        const it = ev.item || {};
        if (it.type === 'command_execution') opts.onActivity?.(`$ ${oneLine(it.command, 90)}`);
        else if (it.type === 'agent_message' || it.type === 'reasoning') opts.onActivity?.(oneLine(it.text));
        else if (it.type === 'file_change') opts.onActivity?.(`edit ${(it.changes || []).map((c) => c.path).join(', ')}`);
      } else if (ev.type === 'error' || ev.type === 'turn.failed') lastError = oneLine(ev.message || ev.error?.message, 300);
    },
  });

  let output = null;
  try { output = JSON.parse(fs.readFileSync(lastFile, 'utf8')); } catch { /* 下で失敗扱い */ }
  fs.rmSync(tmp, { recursive: true, force: true });
  // codex exec はコストを返さない（サブスクリプション枠）。トークンだけで予算を管理する
  if (!output) return { ok: false, tokens, costUsd: 0, error: r.aborted ? '中断' : `codex: ${lastError || `code ${r.code} ${oneLine(r.stderr, 300)}`}` };
  return { ok: true, output, tokens, costUsd: 0 };
}

// ---------- mock（CLI を呼ばずに閉ループ全体を試す） ----------
const sleep = (ms, signal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

async function mock(opts) {
  const steps = 3 + Math.floor(Math.random() * 4);
  let tokens = 0;
  for (let i = 0; i < steps && !opts.signal?.aborted; i++) {
    await sleep(700 + Math.random() * 900, opts.signal);
    tokens += Math.round(1500 + Math.random() * 3000);
    opts.onUsage?.(tokens);
    opts.onActivity?.(['Read src/…', 'Grep "TODO"', 'Edit ファイル', 'Bash pytest -q', '変更を確認中'][i % 5]);
  }
  if (opts.signal?.aborted) return { ok: false, tokens, costUsd: 0, error: '中断' };
  const costUsd = tokens * 5e-6;

  if (opts.role === 'planner') return { ok: true, tokens, costUsd, output: MOCK_PLAN };
  if (opts.role === 'critic') {
    return { ok: true, tokens, costUsd, output: {
      verdict: 'change_approach', diagnosis: '(mock) 2 回とも同じ前提で実装しており、src/api/ のインタフェースを確認していない',
      flawedAssumptions: ['API クライアントが同期的に値を返すという前提'], unansweredQuestions: ['E2-T1 の戻り値の型は何か'],
      guidance: 'まず src/api/ の公開関数を読み、戻り値の型に合わせて実装し直す',
      revisedTask: { title: '', description: '', writeSet: [] }, humanRequests: [],
    } };
  }
  if (opts.role === 'reviewer') {
    const reject = Math.random() < 0.2;
    return { ok: true, tokens, costUsd, output: {
      verdict: reject ? 'reject' : 'accept', note: reject ? 'エッジケースのテストが不足' : '問題なし',
      fixes: reject ? [{ title: 'エッジケースのテスト追加', description: '空入力のテストを追加する', writeSet: ['tests/'] }] : [],
      humanRequests: [],
    } };
  }
  // worker: writeSet の中に実際にファイルを書く（git のマージまで本物で通す）
  const t = opts.task;
  const ext = opts.kind?.verify === 'artifacts' ? opts.kind.artifacts[0] : 'txt';
  for (const p of t.writeSet) {
    const file = p.endsWith('/') ? path.join(p, `${t.id}.${ext}`) : p;
    fs.mkdirSync(path.dirname(path.join(opts.cwd, file)), { recursive: true });
    fs.appendFileSync(path.join(opts.cwd, file), `${t.id} attempt by ${opts.model}/${opts.effort}\n`);
  }
  if (t.id === 'E2-T1' && !opts.replies) {
    return { ok: true, tokens, costUsd, output: { status: 'blocked', summary: 'API キーがないため外部 API を叩けない', humanRequests: [
      { kind: 'auth', title: 'EXAMPLE_API_KEY を設定してほしい', detail: '`export EXAMPLE_API_KEY=...` をオーケストレータ起動前のシェルで設定し、返信欄に「設定済み」と書いてください。', blocking: true },
    ] } };
  }
  // E2-T2 は critic の指示が入るまで失敗し続ける（批判的レビューの流れを試すため）
  if (t.id === 'E2-T2' && !opts.critique) return { ok: true, tokens, costUsd, output: { status: 'gave_up', summary: '(mock) 同じやり方で失敗', humanRequests: [] } };
  if (Math.random() < 0.25) return { ok: true, tokens, costUsd, output: { status: 'gave_up', summary: '(mock) ランダムな失敗', humanRequests: [] } };
  const extra = t.id === 'E1-T1' ? [{ kind: 'install', title: 'ffmpeg を入れてほしい', detail: '`brew install ffmpeg`。動画出力の確認に使う（なくても進められる）', blocking: false }] : [];
  return { ok: true, tokens, costUsd, output: { status: 'done', summary: `(mock) ${t.title} を実装`, humanRequests: extra } };
}

const MOCK_RISK = (c, u, b) => ({ complexity: c, uncertainty: u, blast: b });
const MOCK_PLAN = {
  name: 'mock プロジェクト',
  successCriteria: ['全 task が完了', 'レビューが全て承認'],
  checkCommand: '',
  epics: [
    { id: 'E1', title: '土台づくり', dependsOn: [], risk: MOCK_RISK(0.2, 0.2, 0.3), tasks: [
      { id: 'E1-T1', title: '設定ファイル', description: 'config を作る', kind: 'coder', writeSet: ['config/'], risk: MOCK_RISK(0.1, 0.1, 0.2) },
      { id: 'E1-T2', title: 'ユーティリティ', description: 'utils を作る', writeSet: ['src/utils.txt'], risk: MOCK_RISK(0.3, 0.2, 0.2) },
    ] },
    { id: 'E2', title: 'コア機能', dependsOn: ['E1'], risk: MOCK_RISK(0.7, 0.6, 0.6), tasks: [
      { id: 'E2-T1', title: '外部 API クライアント', description: 'API を叩く', writeSet: ['src/api/'], risk: MOCK_RISK(0.6, 0.6, 0.5) },
      { id: 'E2-T2', title: 'コアロジック', description: '本体', writeSet: ['src/core.txt', 'src/api/'], risk: MOCK_RISK(0.8, 0.7, 0.7) },
    ] },
    { id: 'E3', title: 'ドキュメントと素材', dependsOn: ['E1'], risk: MOCK_RISK(0.1, 0.1, 0.1), tasks: [
      { id: 'E3-T1', title: 'README', description: 'README を書く', kind: 'writer', writeSet: ['docs/'], risk: MOCK_RISK(0.1, 0.1, 0.1) },
      { id: 'E3-T2', title: 'アイコン画像', description: 'アプリのアイコンを作る', kind: 'illustrator', writeSet: ['assets/icons/'], risk: MOCK_RISK(0.2, 0.3, 0.1) },
      { id: 'E3-T3', title: 'ロゴの 3D レンダー', description: 'ロゴを 3D にしてレンダリング', kind: 'blender', writeSet: ['assets/3d/'], risk: MOCK_RISK(0.4, 0.4, 0.1) },
      { id: 'E3-T4', title: 'デモ動画の書き出し', description: 'スクリーン録画を mp4 にまとめる', kind: 'video-editor', writeSet: ['assets/video/'], risk: MOCK_RISK(0.2, 0.2, 0.1) },
    ] },
  ],
  newKinds: [
    { name: 'video-editor', basedOn: 'coder', description: '動画の編集・書き出し（ffmpeg）', instructions: 'ffmpeg で編集し、書き出した動画のサムネイル PNG も保存する', tools: ['Bash(ffmpeg:*)'], requires: ['ffmpeg'] },
    { name: 'releaser', basedOn: 'coder', description: 'リリース作業', instructions: 'タグを打って push する', tools: ['Bash(git push:*)'], requires: [] },
  ],
  humanRequests: [{ kind: 'decision', title: 'ライセンスを決めてほしい', detail: 'MIT / Apache-2.0 のどちらにするか返信してください', blocking: false }],
};

module.exports = { claude, codex, mock, probeRateLimit };
