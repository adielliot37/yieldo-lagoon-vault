const DEFAULT_WEIGHTS = {
  capital: 0.25,
  performance: 0.35,
  risk: 0.40,
};

function normalizeScore(value, min, max) {
  if (value == null || isNaN(value)) return null;
  const lo = min ?? 0;
  const hi = max ?? 100;
  if (hi === lo) return 50;
  const x = Math.max(lo, Math.min(hi, value));
  return ((x - lo) / (hi - lo)) * 100;
}

export function capitalScore(metrics) {
  const { tvlChange1d, tvlChange7d, tvlChange30d, netFlows7d, netFlows30d, uniqueDepositors, avgDepositDurationDays, tvl } = metrics;
  const parts = [];
  const trend = tvlChange30d ?? tvlChange7d ?? tvlChange1d;
  if (trend != null) parts.push(normalizeScore(trend + 50, -50, 50));
  if (tvl > 0n && (netFlows7d != null || netFlows30d != null)) {
    const flow = Number(netFlows30d ?? netFlows7d ?? 0n) / Number(tvl);
    parts.push(normalizeScore(flow * 100 + 50, -50, 50));
  }
  if (uniqueDepositors != null) parts.push(Math.min(100, uniqueDepositors * 5));
  if (avgDepositDurationDays != null) parts.push(Math.min(100, avgDepositDurationDays * (100 / 90)));
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

export function performanceScore(metrics) {
  const apr = metrics.apr30d ?? metrics.aprAll;
  const { returnVolatility30d, maxDrawdown30d, maxDrawdown90d, sharpeRatio } = metrics;
  const parts = [];
  if (apr != null && !isNaN(apr)) {
    const aprPct = apr * 100;
    parts.push(Math.min(100, Math.max(0, aprPct * (100 / 20))));
  }
  if (sharpeRatio != null && !isNaN(sharpeRatio)) {
    parts.push(Math.min(100, Math.max(0, sharpeRatio * (100 / 3))));
  } else if (apr != null && returnVolatility30d != null && returnVolatility30d > 0.001) {
    const sharpe = apr / returnVolatility30d;
    parts.push(Math.min(100, Math.max(0, sharpe * (100 / 3))));
  }
  const dd = maxDrawdown90d ?? maxDrawdown30d;
  if (dd != null && !isNaN(dd)) {
    const ddPct = dd * 100;
    parts.push(100 - Math.min(100, ddPct * 2));
  }
  
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

export function riskScore(metrics) {
  let score = 100;
  if (metrics.vaultPaused) score -= 30;
  if (metrics.emergencyWithdraw) score -= 50;
  if (metrics.assetDepeg === true) score -= 40;
  if (metrics.governanceAction) score -= 15;
  return Math.max(0, score);
}

export function derivedIndicators(metrics, tvl) {
  const tvlNum = Number(tvl ?? 0n);
  const tvlChange = metrics.tvlChange30d ?? metrics.tvlChange7d;
  const avgDuration = metrics.avgDepositDurationDays;
  const netFlows = metrics.netFlows30d ?? metrics.netFlows7d;
  const apr = metrics.apr30d ?? metrics.aprAll;
  const vol = metrics.returnVolatility30d;
  const dd30 = metrics.maxDrawdown30d;
  const dd90 = metrics.maxDrawdown90d;
  const capitalStabilityScore = (avgDuration != null && tvlChange != null)
    ? avgDuration * (1 + tvlChange / 100)
    : null;
  const flowMomentum = (tvlNum > 0 && netFlows != null)
    ? Number(netFlows) / tvlNum
    : null;
  const returnStability = (apr != null && vol != null && vol > 0.001)
    ? apr / vol
    : null;
  const drawdownBreachFlag = (dd30 != null && dd30 > 0.10) || (dd90 != null && dd90 > 0.15);
  
  return {
    capitalStabilityScore,
    flowMomentum,
    returnStability,
    drawdownBreachFlag,
    depegRiskFlag: metrics.assetDepeg === true,
  };
}

export function compositeScore(metrics, weights = DEFAULT_WEIGHTS) {
  const cap = capitalScore(metrics);
  const perf = performanceScore(metrics);
  const risk = riskScore(metrics);
  const w = weights;
  let total = 0;
  let div = 0;
  if (cap != null) { total += cap * w.capital; div += w.capital; }
  if (perf != null) { total += perf * w.performance; div += w.performance; }
  if (risk != null) { total += risk * w.risk; div += w.risk; }
  if (div === 0) return null;
  return Math.round((total / div) * 100) / 100;
}

export function capitalScoreLagoon(metrics) {
  const tvlUsd = metrics.tvlUsd;
  
  if (tvlUsd == null || tvlUsd <= 0) return null;
  let tvlScore;
  if (tvlUsd >= 50_000_000) {
    tvlScore = 100;
  } else if (tvlUsd >= 10_000_000) {
    tvlScore = 80 + ((tvlUsd - 10_000_000) / 40_000_000) * 20;
  } else if (tvlUsd >= 1_000_000) {
    tvlScore = 50 + ((tvlUsd - 1_000_000) / 9_000_000) * 30;
  } else {
    tvlScore = (tvlUsd / 1_000_000) * 50;
  }
  
  return Math.min(100, Math.max(0, tvlScore));
}

export function performanceScoreLagoon(metrics) {
  const apr7d = metrics.apr7d;
  const apr30d = metrics.apr30d;
  const aprAll = metrics.aprAll;
  const parts = [];
  if (apr7d != null && !isNaN(apr7d)) {
    const aprPct = apr7d * 100;
    const score = 20 + Math.min(80, aprPct * 4);
    parts.push({ score, weight: 0.4 });
  }
  if (apr30d != null && !isNaN(apr30d)) {
    const aprPct = apr30d * 100;
    const score = 20 + Math.min(80, aprPct * 4);
    parts.push({ score, weight: 0.35 });
  }
  if (aprAll != null && !isNaN(aprAll)) {
    const aprPct = aprAll * 100;
    const score = 20 + Math.min(80, aprPct * 4);
    parts.push({ score, weight: 0.25 });
  }
  if (parts.length === 0) return null;
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const weightedSum = parts.reduce((sum, p) => sum + p.score * p.weight, 0);
  
  return Math.min(100, Math.max(0, weightedSum / totalWeight));
}

export function riskScoreLagoon(metrics) {
  let score = 100;
  if (metrics.vaultPaused) score -= 30;
  if (metrics.vaultState === 'Closed') score -= 50;
  if (metrics.assetDepeg === true) score -= 40;
  if (metrics.performanceFee != null && metrics.performanceFee > 2500) {
    score -= 10;
  }
  if (metrics.isWhitelistActivated) score -= 5;
  return Math.max(0, score);
}

export function compositeScoreLagoon(metrics, userAnalytics = null) {
  const cap = capitalScoreLagoon(metrics);
  const perf = performanceScoreLagoon(metrics);
  const risk = riskScoreLagoon(metrics);
  const trust = userAnalytics?.trustScore ?? null;
  let total = 0;
  let div = 0;
  if (trust != null) {
    const w = { capital: 0.20, performance: 0.30, risk: 0.30, trust: 0.20 };
    if (cap != null) { total += cap * w.capital; div += w.capital; }
    if (perf != null) { total += perf * w.performance; div += w.performance; }
    if (risk != null) { total += risk * w.risk; div += w.risk; }
    if (trust != null) { total += trust * w.trust; div += w.trust; }
  } else {
    const w = DEFAULT_WEIGHTS;
    if (cap != null) { total += cap * w.capital; div += w.capital; }
    if (perf != null) { total += perf * w.performance; div += w.performance; }
    if (risk != null) { total += risk * w.risk; div += w.risk; }
  }
  
  if (div === 0) return null;
  return Math.round((total / div) * 100) / 100;
}
