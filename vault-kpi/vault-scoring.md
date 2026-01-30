# Vault KPI: Scoring and Calculations

## Overview

Vaults are evaluated with a composite score built from capital, performance, and risk. When user analytics are available, a trust component is added. All sub-scores are 0–100; composite is a weighted average.

---

## Composite Score

**Without trust (default weights):**
- capital: 0.25, performance: 0.35, risk: 0.40
- `composite = (capital * 0.25 + performance * 0.35 + risk * 0.40) / (sum of weights for present scores)`

**With trust (Lagoon + user analytics):**
- capital: 0.20, performance: 0.30, risk: 0.30, trust: 0.20
- Same pattern: sum `score_i * weight_i` over present scores, divide by sum of those weights.

Result is rounded to 2 decimals. If a sub-score is null, it is excluded and its weight is not used.

---

## Capital Score (Lagoon path)

Based on TVL USD only.

- TVL >= 50M: 100
- 10M <= TVL < 50M: `80 + (tvlUsd - 10_000_000) / 40_000_000 * 20`
- 1M <= TVL < 10M: `50 + (tvlUsd - 1_000_000) / 9_000_000 * 30`
- TVL < 1M: `(tvlUsd / 1_000_000) * 50`

Final: `min(100, max(0, tvlScore))`.

---

## Performance Score (Lagoon path)

Uses APR 7d, 30d, and all-time. Each APR (as decimal) is converted to a 20–100 sub-score:

- `aprPct = apr * 100`
- `score = 20 + min(80, aprPct * 4)`

Weights: 7d = 0.40, 30d = 0.35, all = 0.25.  
Performance = weighted average of present APR sub-scores, then `min(100, max(0, ...))`.

---

## Risk Score (Lagoon path)

Starts at 100, then subtract:

- vault paused: -30
- vault state Closed: -50
- asset depeg (price < 0.98): -40
- performance fee > 2500 (bps): -10
- whitelist activated: -5

Result: `max(0, score)`.

---

## Trust Score (user analytics)

Used only when Lagoon + user analytics are available.

- Base: 50
- `+ (retentionRate / 100) * 20`
- `+ min(15, (avgHoldingDays / 90) * 15)`
- `+ (1 - quickExitRate / 100) * 15`
- If totalUsers >= 10: +10; else: +totalUsers (capped by formula)
- If holdersOver90Days >= 5: +5

Final: `min(100, max(0, round(score)))`.

Definitions (from analytics):
- retentionRate: activeHolders / totalUsers * 100
- quickExitRate: quickExiters / exitedUsers * 100 (exited users who left within 7 days)
- avgHoldingDays: mean of holding duration in days for active holders

---

## Alternative Path (indexer/on-chain metrics)

When not using Lagoon, the same composite formula can use different sub-scores.

**Capital (indexer):** Average of (each present component 0–100):
- TVL trend: `normalize(tvlChange30d + 50, -50, 50)` (or 7d/1d if 30d missing)
- Net flow: if TVL > 0 and netFlows present, `normalize(netFlows/tvl * 100 + 50, -50, 50)`
- Unique depositors: `min(100, uniqueDepositors * 5)`
- Avg deposit duration (days): `min(100, avgDepositDurationDays * (100/90))`

`normalize(x, lo, hi) = ((clamp(x, lo, hi) - lo) / (hi - lo)) * 100`.

**Performance (indexer):** Average of:
- APR: `min(100, max(0, apr * 100 * (100/20)))` (20% APR → 100)
- Sharpe: if provided, `min(100, max(0, sharpeRatio * (100/3)))`; else if APR and returnVolatility30d > 0.001, `sharpe = apr / returnVolatility30d`, same scaling
- Drawdown: `100 - min(100, maxDrawdownPct * 2)` (e.g. 50% dd → 0)

**Risk (indexer):** Start 100; subtract: paused -30, emergencyWithdraw -50, assetDepeg -40, governanceAction -15; `max(0, score)`.

---

## Input Metrics (calculations)

**TVL change (%), N days:**  
`(tvlToday - tvlPast) / tvlPast * 100`. Uses snapshot total_assets for today and N days ago; if no snapshot for today, use latest snapshot date.

**Net flows (N days):** Sum of deposit amounts (status executed/settled) minus sum of withdrawal amounts (status pending/settled/withdrawn), over the window. Withdrawals in shares are converted to assets via vault `convertToAssets(shares)` when needed.

**Share price (from snapshot):** If `share_price` present and non-zero: `share_price / 1e6`. Else: `total_assets / total_supply` (with 1e18 scaling). Used for returns and APY.

**Realized APY (period):** From first and last share price in snapshot range.  
`ratio = lastPrice / firstPrice`, `actualDays` = calendar days between first and last date (min 1).  
`APY = ratio^(365/actualDays) - 1`.

**Daily returns:** For each consecutive snapshot pair, `(price_t - price_{t-1}) / price_{t-1}`.

**Return volatility (annualized):** Std dev of daily returns, then `std * sqrt(365)`.

**Max drawdown:** Over sorted-by-date snapshots, track running peak; at each point, `drop = (peak - price) / peak`; max drop is the drawdown (0–1).

**Depeg:** Underlying asset price (USD) < 0.98.

---

## Derived Indicators (optional)

- capitalStabilityScore: `avgDepositDurationDays * (1 + tvlChange/100)` when both present
- flowMomentum: `netFlows / tvl` (when tvl > 0)
- returnStability: `apr / returnVolatility30d` when vol > 0.001
- drawdownBreachFlag: maxDrawdown30d > 0.10 or maxDrawdown90d > 0.15
- depegRiskFlag: asset price < 0.98
