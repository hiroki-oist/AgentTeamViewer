// 監視役（別系統）の判定ロジック。
// 実行系のエージェントとは独立に状態を読むだけで、介入は「停止/昇格凍結を提案する」ところまで。
// ブラウザ（window.ATV）と Node（require）の両方から読めるようにしている。
var ATV = (globalThis.ATV = globalThis.ATV || {});

ATV.watchdog = (() => {
  const RANK = { ok: 0, warn: 1, crit: 2 };

  function evaluate(state, lockInfo) {
    const w = state.watchdog;
    const alerts = [];
    const push = (level, msg) => alerts.push({ level, msg });

    // 1. トークン予算
    const tokenRatio = w.usedTokens / w.budget.tokens;
    const costRatio = w.usedCostUsd / w.budget.costUsd;
    const budgetRatio = Math.max(tokenRatio, costRatio);
    if (budgetRatio >= 0.9) push('crit', `予算の ${(budgetRatio * 100).toFixed(0)}% を消費`);
    else if (budgetRatio >= 0.7) push('warn', `予算の ${(budgetRatio * 100).toFixed(0)}% を消費`);

    // 2. 消費速度（直近5分平均）と枯渇予測
    const recent = w.burn.slice(-5);
    const burnNow = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (burnNow >= w.limits.burnCritPerMin) push('crit', `消費速度 ${fmtK(burnNow)} tok/min（上限 ${fmtK(w.limits.burnCritPerMin)}）`);
    else if (burnNow >= w.limits.burnWarnPerMin) push('warn', `消費速度 ${fmtK(burnNow)} tok/min（警告 ${fmtK(w.limits.burnWarnPerMin)}）`);
    const minutesLeft = (w.budget.tokens - w.usedTokens) / Math.max(burnNow, 1);

    // 2'. プランの利用枠（claude の 5 時間枠・週の枠）
    const plan = w.plan;
    if (plan) {
      const L = w.limits, pct = (x) => `${Math.round(x * 100)}%`;
      const d = plan.sevenDay, f = plan.fiveHour;
      if (state.run?.planHold) push('crit', `利用枠で停止中: ${state.run.planHold.reason}`);
      else if (d && L.planWeekStop > 0 && d.utilization >= L.planWeekStop * 0.95) push('crit', `週の枠 ${pct(d.utilization)}（停止 ${pct(L.planWeekStop)}）`);
      else if (d && L.planWeekWarn > 0 && d.utilization >= L.planWeekWarn) push('warn', `週の枠 ${pct(d.utilization)}（警告 ${pct(L.planWeekWarn)}）`);
      if (!state.run?.planHold && f && L.planFiveHourStop > 0 && f.utilization >= Math.min(0.8, L.planFiveHourStop)) push('warn', `5 時間枠 ${pct(f.utilization)}`);
    }

    // 2'''. メモリ
    if (state.run?.memHold) push('crit', `メモリ不足で停止中（空き ${state.watchdog.mem?.availGb ?? '?'} GB）`);
    else if (w.mem && w.mem.minGb > 0 && w.mem.availGb < w.mem.minGb * 2) push('warn', `メモリの空き ${w.mem.availGb} GB`);

    // 2''. 点検役の最後の結果
    const ins = state.inspector;
    if (ins) {
      const hm = new Date(ins.at).toTimeString().slice(0, 5);
      if (ins.stage === 2) push(ins.actions?.length ? 'warn' : 'ok', `点検 ${hm}: ${ins.actions?.length ? ins.actions.join(' / ') : '検査したが対応なし'}`);
      else push('ok', `点検 ${hm}: 異常なし`);
    }

    // 3. 同時稼働エージェント数
    const active = Object.values(state.agents).filter((a) => a.state === 'active' && a.role !== 'watchdog').length;
    if (active > w.limits.maxActiveAgents) push('crit', `稼働エージェント ${active} > 上限 ${w.limits.maxActiveAgents}`);

    // 4. リトライ暴走（同一 task の試行回数）
    for (const e of state.epics)
      for (const t of e.tasks) {
        const fails = t.attempts.filter((a) => a.result === 'fail').length;
        if (t.status === 'critique') push('warn', `${t.id}: ${fails} 回失敗 → critic が原因と進め方を検証中`);
        else if (t.status === 'failed') push('crit', `${t.id}: 試行 ${t.attempts.length} 回で失敗。昇格停止 → 人間判断が必要`);
        else if (t.status !== 'done' && t.attempts.length >= w.limits.maxAttemptsPerTask) push('crit', `${t.id}: 試行 ${t.attempts.length} 回。昇格停止 → 人間判断を推奨`);
        else if (fails >= 1 && t.status === 'running') push('warn', `${t.id}: ${fails} 回失敗後に昇格中 (${last(t.attempts).model}/${last(t.attempts).effort})`);
      }

    // 5. ロック
    for (const [a, b] of lockInfo.violations) push('crit', `ロック違反: ${a.taskId} と ${b.taskId} が ${a.path} を同時保持`);
    if (lockInfo.waits.length) push('ok', `ロック待ち ${new Set(lockInfo.waits.map((x) => x.taskId)).size} 件（正常な直列化）`);

    // 6. 人間への依頼（アプリ導入・認証など）
    const open = (state.requests || []).filter((r) => r.status === 'open');
    const blocking = open.filter((r) => r.blocking).length;
    if (blocking) push('warn', `人間待ちの依頼 ${blocking} 件（該当 task は停止中）`);
    else if (open.length) push('ok', `未対応の依頼 ${open.length} 件（非ブロッキング）`);

    const level = alerts.reduce((m, a) => (RANK[a.level] > RANK[m] ? a.level : m), 'ok');
    alerts.sort((a, b) => RANK[b.level] - RANK[a.level]);
    return { level, alerts, tokenRatio, costRatio, burnNow, minutesLeft, active };
  }

  const last = (arr) => arr[arr.length - 1];
  const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

  return { evaluate, fmtK };
})();

if (typeof module !== 'undefined') module.exports = ATV.watchdog;
