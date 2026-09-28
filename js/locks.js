// ファイルロック管理。
// ルール:
//   1. running / review の task は writeSet 全体を排他ロックとして保持する（レビュー中も他者は触れない）
//   2. "dir/" はディレクトリ配下すべて。"src/envs/" と "src/envs/obs.py" は衝突する
//   3. todo の task は writeSet が全て空いたときだけ running へ遷移できる（all-or-nothing 取得でデッドロック回避）
// ブラウザ（window.ATV）と Node（require）の両方から読めるようにしている。
var ATV = (globalThis.ATV = globalThis.ATV || {});

ATV.locks = (() => {
  const HOLDING = new Set(['running', 'review']);

  const conflicts = (a, b) =>
    a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));

  // レビュー中の epic は、配下 task の writeSet を epic 全体でまとめて保持する（同 epic 内の重なりは違反ではない）
  const sameReview = (a, b) => a.status === 'review' && b.status === 'review' && a.epicId === b.epicId;

  const allTasks = (state) => state.epics.flatMap((e) => e.tasks.map((t) => ({ ...t, epicId: e.id, epicStatus: e.status })));

  function compute(state) {
    const tasks = allTasks(state);
    const held = [];
    for (const t of tasks) {
      if (!HOLDING.has(t.status)) continue;
      for (const path of t.writeSet) held.push({ path, taskId: t.id, epicId: t.epicId, agent: t.agent, status: t.status });
    }

    // 同時保持の違反（本来起きてはいけない。監視役が CRIT を出す）
    const violations = [];
    for (let i = 0; i < held.length; i++)
      for (let j = i + 1; j < held.length; j++)
        if (held[i].taskId !== held[j].taskId && conflicts(held[i].path, held[j].path) && !sameReview(held[i], held[j]))
          violations.push([held[i], held[j]]);

    // 着手待ちで、ロックが原因で動けない task
    const waits = [];
    for (const t of tasks) {
      if (t.status !== 'todo' || !t.agent || t.epicStatus !== 'running') continue;
      for (const path of t.writeSet) {
        const h = held.find((x) => conflicts(x.path, path));
        if (h) waits.push({ taskId: t.id, path, heldPath: h.path, heldBy: h.taskId });
      }
    }
    return { held, violations, waits };
  }

  const canAcquire = (state, task) => {
    const { held } = compute(state);
    return task.writeSet.every((p) => !held.some((h) => h.taskId !== task.id && conflicts(h.path, p)));
  };

  return { compute, canAcquire, conflicts };
})();

if (typeof module !== 'undefined') module.exports = ATV.locks;
