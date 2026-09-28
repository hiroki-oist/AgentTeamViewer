// 推論の重さのルーティング（adaptive inference budgeting）。
// リスクから初期の段を決め、失敗するたびに梯子を 1 段上げる。
// ブラウザ（デモのシミュレーション）とオーケストレータの両方がこのファイルを使う。
var ATV = (globalThis.ATV = globalThis.ATV || {});

ATV.policy = (() => {
  // runner: 実際に起動する CLI。model はボードの色分けにも使う表示名。
  const LADDERS = {
    claude: [
      { runner: 'claude', model: 'haiku', effort: 'low' }, { runner: 'claude', model: 'haiku', effort: 'medium' },
      { runner: 'claude', model: 'sonnet', effort: 'medium' }, { runner: 'claude', model: 'sonnet', effort: 'high' },
      { runner: 'claude', model: 'opus', effort: 'high' }, { runner: 'claude', model: 'opus', effort: 'xhigh' },
    ],
    // codex は ~/.codex/config.toml の既定モデルを使い、effort だけを変える
    codex: [
      { runner: 'codex', model: 'codex', effort: 'low' }, { runner: 'codex', model: 'codex', effort: 'medium' },
      { runner: 'codex', model: 'codex', effort: 'high' }, { runner: 'codex', model: 'codex', effort: 'xhigh' },
    ],
    mixed: [
      { runner: 'claude', model: 'haiku', effort: 'low' }, { runner: 'claude', model: 'haiku', effort: 'medium' },
      { runner: 'claude', model: 'sonnet', effort: 'medium' }, { runner: 'codex', model: 'codex', effort: 'high' },
      { runner: 'claude', model: 'opus', effort: 'high' }, { runner: 'claude', model: 'opus', effort: 'xhigh' },
    ],
  };
  // 実際には CLI を呼ばず、同じ梯子の形でダミー実行する
  LADDERS.mock = LADDERS.claude.map((x) => ({ ...x, runner: 'mock' }));

  const riskScore = (r) => 0.5 * r.complexity + 0.3 * r.uncertainty + 0.2 * r.blast;

  // 6 段の梯子を基準にした閾値。段数が違う梯子では比率で合わせる。
  function baseIndex(score, n) {
    const six = score < 0.2 ? 0 : score < 0.35 ? 1 : score < 0.5 ? 2 : score < 0.7 ? 3 : score < 0.85 ? 4 : 5;
    return Math.round((six * (n - 1)) / 5);
  }

  function route(risk, failures = 0, ladder = LADDERS.claude) {
    const i = baseIndex(riskScore(risk), ladder.length);
    return ladder[Math.min(i + failures, ladder.length - 1)];
  }

  function escalate(attempt, ladder = LADDERS.claude) {
    const i = ladder.findIndex((x) => x.model === attempt.model && x.effort === attempt.effort);
    return ladder[Math.min((i < 0 ? Math.floor(ladder.length / 2) : i) + 1, ladder.length - 1)];
  }

  // 計画とレビューは判断の要所なので、梯子の上から 2 段目を使う
  const judge = (ladder) => ladder[Math.max(0, ladder.length - 2)];

  return { LADDERS, riskScore, route, escalate, judge };
})();

if (typeof module !== 'undefined') module.exports = ATV.policy;
