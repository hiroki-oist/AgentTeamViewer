// ダミーの盤面状態。将来はオーケストレータが同じ形の JSON を吐き出し、
// ボードはそれを読むだけ（ボード側は状態を「表示」するだけで決定はしない）。
//
// 階層:  project(目標) > epics(中プロジェクト, 1リード) > tasks(小プロジェクト, 1タスク1エージェント)
// ロック: 各 task は writeSet を宣言し、実行中は writeSet の全ファイルを排他ロックする。
//         "dir/" で終わるパスはディレクトリ配下すべてを意味する。
window.ATV = window.ATV || {};

ATV.dummyState = () => ({
  project: {
    id: 'P-001',
    name: 'LIBERO-CTRL 実装',
    goal: 'LIBERO-CTRL をこの repo に実装し、baseline 3 種を動かしてベンチマーク結果と README を揃える',
    successCriteria: [
      '全 baseline が LIBERO-10 で再現値 ±3% 以内',
      'pytest 全通過 + CI green',
      'README に再現手順と結果表',
    ],
    repo: 'github.com/example/libero-ctrl',
    startedAt: '2026-09-28T19:40:00+09:00',
  },

  // 中プロジェクト。status: todo | running | review | done
  epics: [
    {
      id: 'E1', title: '環境セットアップ & データローダ', status: 'done',
      lead: 'lead-E1', risk: { complexity: 0.3, uncertainty: 0.2, blast: 0.4 }, dependsOn: [],
      tasks: [
        { id: 'E1-T1', kind: 'coder', title: 'conda env / requirements 固定', status: 'done', agent: 'w-E1-1', writeSet: ['environment.yml', 'requirements.txt'], tokens: 18400,
          attempts: [{ model: 'haiku', effort: 'low', result: 'ok' }] },
        { id: 'E1-T2', kind: 'coder', title: 'LIBERO HDF5 ローダ', status: 'done', agent: 'w-E1-2', writeSet: ['src/data/'], tokens: 61200,
          attempts: [{ model: 'sonnet', effort: 'medium', result: 'fail', note: 'episode 境界の off-by-one' }, { model: 'sonnet', effort: 'high', result: 'ok' }] },
      ],
    },
    {
      id: 'E8', title: 'CI & テスト基盤', status: 'done',
      lead: 'lead-E8', risk: { complexity: 0.2, uncertainty: 0.1, blast: 0.3 }, dependsOn: [],
      tasks: [
        { id: 'E8-T1', kind: 'coder', title: 'GitHub Actions (lint + pytest)', status: 'done', agent: 'w-E8-1', writeSet: ['.github/workflows/ci.yml'], tokens: 9800,
          attempts: [{ model: 'haiku', effort: 'low', result: 'ok' }] },
      ],
    },
    {
      id: 'E2', title: 'LIBERO-CTRL コア実装', status: 'running',
      lead: 'lead-E2', risk: { complexity: 0.85, uncertainty: 0.7, blast: 0.8 }, dependsOn: ['E1'],
      tasks: [
        { id: 'E2-T1', kind: 'coder', title: 'controller policy head', status: 'done', agent: 'w-E2-1', writeSet: ['src/ctrl/head.py'], tokens: 88100,
          attempts: [{ model: 'sonnet', effort: 'high', result: 'ok' }] },
        { id: 'E2-T2', kind: 'coder', title: 'rollout loop / env wrapper', status: 'running', agent: 'w-E2-2', writeSet: ['src/ctrl/rollout.py', 'src/envs/'], tokens: 142300,
          attempts: [{ model: 'sonnet', effort: 'high', result: 'fail', note: '非同期 env で deadlock' }, { model: 'opus', effort: 'high', result: 'running' }] },
        { id: 'E2-T3', kind: 'coder', title: 'config schema (hydra)', status: 'running', agent: 'w-E2-3', writeSet: ['configs/ctrl/', 'src/ctrl/config.py'], tokens: 23500,
          attempts: [{ model: 'haiku', effort: 'medium', result: 'running' }] },
        { id: 'E2-T4', kind: 'tester', title: 'rollout の単体テスト', status: 'todo', agent: 'w-E2-4', writeSet: ['tests/test_rollout.py', 'src/ctrl/rollout.py'], tokens: 0,
          attempts: [] },
      ],
    },
    {
      id: 'E3', title: 'Baseline: Diffusion Policy', status: 'running',
      lead: 'lead-E3', risk: { complexity: 0.6, uncertainty: 0.5, blast: 0.3 }, dependsOn: ['E1'],
      tasks: [
        { id: 'E3-T1', kind: 'coder', title: 'DP 学習スクリプト移植', status: 'running', agent: 'w-E3-1', writeSet: ['baselines/dp/'], tokens: 97600,
          attempts: [{ model: 'codex', effort: 'high', result: 'running' }] },
        { id: 'E3-T2', kind: 'coder', title: 'env wrapper に DP 用 obs 追加', status: 'todo', agent: 'w-E3-2', writeSet: ['src/envs/obs.py'], tokens: 0,
          attempts: [] }, // src/envs/ は E2-T2 がロック中 → 待機
      ],
    },
    {
      id: 'E4', title: 'Baseline: ACT', status: 'review',
      lead: 'lead-E4', risk: { complexity: 0.5, uncertainty: 0.4, blast: 0.3 }, dependsOn: ['E1'],
      tasks: [
        { id: 'E4-T1', kind: 'coder', title: 'ACT 実装 + 学習', status: 'done', agent: 'w-E4-1', writeSet: ['baselines/act/'], tokens: 120400,
          attempts: [{ model: 'sonnet', effort: 'high', result: 'ok' }] },
        { id: 'E4-T2', kind: 'researcher', title: 'LIBERO-10 評価 (seed×3)', status: 'review', agent: 'w-E4-2', writeSet: ['results/act/'], tokens: 34100,
          attempts: [{ model: 'haiku', effort: 'medium', result: 'ok' }] },
      ],
      review: { reviewer: 'rev-1', verdict: 'pending', note: '成功率が論文値より 6% 低い。seed 依存か要確認' },
    },
    {
      id: 'E5', title: 'Baseline: OpenVLA fine-tune', status: 'todo',
      lead: null, risk: { complexity: 0.75, uncertainty: 0.8, blast: 0.4 }, dependsOn: ['E1'],
      tasks: [
        { id: 'E5-T1', kind: 'researcher', title: 'LoRA fine-tune 設定調査', status: 'todo', agent: null, writeSet: ['baselines/openvla/'], tokens: 0, attempts: [] },
        { id: 'E5-T2', kind: 'coder', title: 'fine-tune 実行 & ckpt 管理', status: 'todo', agent: null, writeSet: ['baselines/openvla/', 'scripts/ft_openvla.sh'], tokens: 0, attempts: [] },
      ],
    },
    {
      id: 'E6', title: 'ベンチマーク実行 & 異常調査', status: 'todo',
      lead: null, risk: { complexity: 0.7, uncertainty: 0.9, blast: 0.5 }, dependsOn: ['E2', 'E3', 'E4', 'E5'],
      tasks: [
        { id: 'E6-T1', kind: 'researcher', title: '全手法 × LIBERO-10/90 実行', status: 'todo', agent: null, writeSet: ['results/'], tokens: 0, attempts: [] },
        { id: 'E6-T2', kind: 'researcher', title: '異常値の原因調査', status: 'todo', agent: null, writeSet: [], tokens: 0, attempts: [] },
      ],
    },
    {
      id: 'E7', title: 'README / ドキュメント', status: 'todo',
      lead: null, risk: { complexity: 0.15, uncertainty: 0.1, blast: 0.1 }, dependsOn: ['E6'],
      tasks: [
        { id: 'E7-T1', kind: 'writer', title: 'README 再現手順 + 結果表', status: 'todo', agent: null, writeSet: ['README.md', 'docs/'], tokens: 0, attempts: [] },
      ],
    },
  ],

  // エージェント。role: lead | worker | reviewer | watchdog
  agents: {
    'lead-E1': { role: 'lead', model: 'sonnet', effort: 'medium', state: 'finished' },
    'lead-E8': { role: 'lead', model: 'haiku', effort: 'medium', state: 'finished' },
    'lead-E2': { role: 'lead', model: 'opus', effort: 'high', state: 'active' },
    'lead-E3': { role: 'lead', model: 'sonnet', effort: 'high', state: 'active' },
    'lead-E4': { role: 'lead', model: 'sonnet', effort: 'medium', state: 'waiting' },
    'w-E1-1': { role: 'worker', model: 'haiku', effort: 'low', state: 'finished' },
    'w-E1-2': { role: 'worker', model: 'sonnet', effort: 'high', state: 'finished' },
    'w-E8-1': { role: 'worker', model: 'haiku', effort: 'low', state: 'finished' },
    'w-E2-1': { role: 'worker', model: 'sonnet', effort: 'high', state: 'finished' },
    'w-E2-2': { role: 'worker', model: 'opus', effort: 'high', state: 'active' },
    'w-E2-3': { role: 'worker', model: 'haiku', effort: 'medium', state: 'active' },
    'w-E2-4': { role: 'worker', model: 'sonnet', effort: 'medium', state: 'waiting' },
    'w-E3-1': { role: 'worker', model: 'codex', effort: 'high', state: 'active' },
    'w-E3-2': { role: 'worker', model: 'haiku', effort: 'medium', state: 'waiting' },
    'w-E4-1': { role: 'worker', model: 'sonnet', effort: 'high', state: 'finished' },
    'w-E4-2': { role: 'worker', model: 'haiku', effort: 'medium', state: 'finished' },
    'rev-1': { role: 'reviewer', model: 'opus', effort: 'xhigh', state: 'active' },
    'watchdog': { role: 'watchdog', model: 'haiku', effort: 'low', state: 'active' },
  },

  // 監視役（別系統）。予算と閾値。
  watchdog: {
    agent: 'watchdog',
    budget: { tokens: 3_000_000, costUsd: 60 },
    limits: { maxActiveAgents: 8, maxAttemptsPerTask: 3, burnWarnPerMin: 25_000, burnCritPerMin: 45_000 },
    // 直近 30 分の tokens/min（古い→新しい）
    burn: [4200, 5100, 6800, 7300, 9100, 12400, 11800, 13600, 15200, 14100, 16900, 18200, 17400, 19800, 21300,
      20100, 22800, 24500, 23100, 26400, 28900, 27200, 25600, 24100, 26800, 29300, 27700, 26200, 28400, 27100],
    usedTokens: 1_724_000,
    usedCostUsd: 31.8,
    // プランの利用枠（デモ用。リセット時刻は表示時点からの相対）
    plan: {
      fiveHour: { utilization: 0.42, resetsAt: new Date(Date.now() + 2.6 * 3600e3).toISOString() },
      sevenDay: { utilization: 0.37, resetsAt: new Date(Date.now() + 4.4 * 86400e3).toISOString() },
    },
  },

  // 人間への依頼。エージェントが自力で解決できないもの（インストール・認証・権限・判断）
  requests: [
    { id: 'R1', kind: 'auth', title: 'Hugging Face のトークンを設定してほしい', detail: 'OpenVLA の重みの取得に必要です。`huggingface-cli login` を実行するか、`HF_TOKEN` を環境変数に設定してから返信してください。',
      blocking: true, status: 'open', reply: '', from: 'w-E3-1', taskId: 'E3-T1', epicId: 'E3', createdAt: '2026-09-28T22:12:00+09:00' },
    { id: 'R2', kind: 'install', title: 'MuJoCo 3.x を入れてほしい', detail: '`pip install mujoco==3.2.*` が sandbox から実行できません。手元の環境で入れてください（なくても他の task は進められます）。',
      blocking: false, status: 'open', reply: '', from: 'w-E2-2', taskId: 'E2-T2', epicId: 'E2', createdAt: '2026-09-28T22:16:00+09:00' },
    { id: 'R3', kind: 'decision', title: '評価 seed 数を決めてほしい', detail: '論文は seed×3 ですが、分散が大きいので ×5 を提案します。',
      blocking: false, status: 'resolved', reply: '×5 で', from: 'rev-1', taskId: null, epicId: 'E4', createdAt: '2026-09-28T22:09:00+09:00' },
  ],

  events: [
    { t: '22:04', kind: 'escalate', msg: 'E2-T2: sonnet/high 失敗 (deadlock) → opus/high に昇格' },
    { t: '22:07', kind: 'lock', msg: 'E3-T2: src/envs/obs.py は E2-T2 (src/envs/) がロック中 → 待機' },
    { t: '22:11', kind: 'review', msg: 'E4 をレビューへ。rev-1 (opus/xhigh) が担当' },
    { t: '22:15', kind: 'done', msg: 'E2-T1 完了。ロック src/ctrl/head.py を解放' },
    { t: '22:19', kind: 'watchdog', msg: 'burn rate が 25k tok/min を超過（WARN）' },
  ],
});
