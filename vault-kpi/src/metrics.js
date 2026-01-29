export async function getTVL(vaultInstance) {
  if (!vaultInstance?.totalAssets) return 0n;
  return vaultInstance.totalAssets;
}

export async function getTVLChange(colSnapshots, vaultId, chain, days) {
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  let snapToday = await colSnapshots.findOne({ date: todayKey, vault_id: vaultId, chain });
  if (!snapToday) {
    const latest = await colSnapshots.findOne(
      { vault_id: vaultId, chain },
      { sort: { date: -1 } }
    );
    if (latest) snapToday = latest;
  }
  const refDate = snapToday ? snapToday.date : todayKey;
  const refDateObj = new Date(refDate + 'T12:00:00Z');
  const past = new Date(refDateObj);
  past.setUTCDate(past.getUTCDate() - days);
  const pastKey = past.toISOString().slice(0, 10);
  const snapPast = await colSnapshots.findOne({ date: pastKey, vault_id: vaultId, chain });
  const tvlToday = BigInt(snapToday?.total_assets || '0');
  const tvlPast = BigInt(snapPast?.total_assets || '0');
  if (tvlPast === 0n) return null;
  return Number((tvlToday - tvlPast) * 10000n / tvlPast) / 100;
}

export async function getNetFlows(colDeposits, colWithdrawals, vaultId, chain, days, vaultInstance) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const [deposits, withdrawals] = await Promise.all([
    colDeposits.find({
      vault_id: vaultId,
      chain,
      status: { $in: ['executed', 'settled'] },
      created_at: { $gte: since },
    }).toArray(),
    colWithdrawals.find({
      vault_id: vaultId,
      chain,
      status: { $in: ['pending', 'settled', 'withdrawn'] },
      created_at: { $gte: since },
    }).toArray(),
  ]);
  let depositsSum = 0n;
  for (const d of deposits) depositsSum += BigInt(d.amount || '0');
  let withdrawalsSum = 0n;
  for (const w of withdrawals) {
    if (w.assets) withdrawalsSum += BigInt(w.assets);
    else if (w.shares && vaultInstance?.totalSupply > 0n) {
      try {
        withdrawalsSum += vaultInstance.convertToAssets(BigInt(w.shares));
      } catch (_) {}
    }
  }
  return depositsSum - withdrawalsSum;
}

export async function getAvgDepositDuration(colDeposits, colWithdrawals, vaultId, chain) {
  const deposits = await colDeposits.find({
    vault_id: vaultId,
    chain,
    status: { $in: ['executed', 'settled'] },
  }).toArray();
  const withdrawals = await colWithdrawals.find({
    vault_id: vaultId,
    chain,
    status: { $in: ['withdrawn'] },
  }).toArray();
  const withdrawByUser = new Map();
  for (const w of withdrawals) {
    const u = (w.user_address || '').toLowerCase();
    const t = w.withdrawn_at ? new Date(w.withdrawn_at).getTime() : (w.settled_at ? new Date(w.settled_at).getTime() : 0);
    if (!withdrawByUser.has(u) || withdrawByUser.get(u) < t) withdrawByUser.set(u, t);
  }
  let sumDays = 0;
  let count = 0;
  const now = Date.now();
  for (const d of deposits) {
    const u = (d.user_address || d.owner || '').toLowerCase();
    const depositTime = new Date(d.created_at || d.executed_at || 0).getTime();
    const withdrawTime = withdrawByUser.get(u) || now;
    if (withdrawTime > depositTime) {
      sumDays += (withdrawTime - depositTime) / (24 * 60 * 60 * 1000);
      count++;
    }
  }
  return count > 0 ? sumDays / count : null;
}

export async function getUniqueDepositors(colDeposits, vaultId, chain) {
  const docs = await colDeposits.find({
    vault_id: vaultId,
    chain,
    status: { $in: ['executed', 'settled'] },
  }).toArray();
  const set = new Set(docs.map(d => (d.user_address || d.owner || '').toLowerCase()).filter(Boolean));
  return set.size;
}

export async function getSnapshotsForPeriod(colSnapshots, vaultId, chain, days) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceKey = since.toISOString().slice(0, 10);
  return colSnapshots
    .find({ vault_id: vaultId, chain, date: { $gte: sinceKey } })
    .sort({ date: 1 })
    .toArray();
}

const warnedVaults = new Set();

function getSharePrice(snapshot) {
  const vaultId = snapshot?.vault_id || 'unknown';
  if (snapshot?.share_price && snapshot.share_price !== '0') {
    return Number(BigInt(snapshot.share_price)) / 1e6;
  }
  const assets = BigInt(snapshot?.total_assets || '0');
  const supply = BigInt(snapshot?.total_supply || '0');
  if (assets === 0n) return null;
  if (supply === 0n) {
    if (!warnedVaults.has(vaultId)) {
      console.warn(`[metrics] ${vaultId}: No share_price and total_supply is 0 - cannot calculate APY`);
      warnedVaults.add(vaultId);
    }
    return null;
  }
  return Number(assets * BigInt(1e18) / supply) / 1e18;
}

export function getRealizedAPY(snapshots, periodDays = 30) {
  if (!snapshots || snapshots.length < 2) return null;
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const firstPrice = getSharePrice(sorted[0]);
  const lastPrice = getSharePrice(sorted[sorted.length - 1]);
  if (firstPrice == null || lastPrice == null || firstPrice === 0) return null;
  const firstDate = new Date(sorted[0].date);
  const lastDate = new Date(sorted[sorted.length - 1].date);
  const actualDays = Math.max(1, (lastDate - firstDate) / (1000 * 60 * 60 * 24));
  const ratio = lastPrice / firstPrice;
  if (ratio <= 0) return null;
  return Math.pow(ratio, 365 / actualDays) - 1;
}

export function getDailyReturns(snapshots) {
  if (!snapshots || snapshots.length < 2) return [];
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const returns = [];
  
  for (let i = 1; i < sorted.length; i++) {
    const prevPrice = getSharePrice(sorted[i - 1]);
    const currPrice = getSharePrice(sorted[i]);
    if (prevPrice == null || currPrice == null || prevPrice === 0) continue;
    returns.push((currPrice - prevPrice) / prevPrice);
  }
  return returns;
}

export function getStdDev(arr) {
  if (!arr.length) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((acc, x) => acc + (x - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

export function getReturnVolatility(snapshots, days = 30) {
  const returns = getDailyReturns(snapshots);
  if (returns.length < 2) return null;
  const std = getStdDev(returns);
  if (std == null) return null;
  return std * Math.sqrt(365);
}

export function getMaxDrawdown(snapshots, days = 90) {
  if (!snapshots || snapshots.length < 2) return null;
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  let peak = 0;
  let maxDrop = 0;
  let validPrices = 0;
  for (const s of sorted) {
    const price = getSharePrice(s);
    if (price == null) continue;
    validPrices++;
    if (price > peak) peak = price;
    if (peak > 0) {
      const drop = (peak - price) / peak;
      if (drop > maxDrop) maxDrop = drop;
    }
  }
  if (validPrices < 2) return null;
  return maxDrop;
}

export function getDownsideDeviation(snapshots) {
  const returns = getDailyReturns(snapshots);
  const negative = returns.filter(r => r < 0);
  if (negative.length === 0) return 0;
  const std = getStdDev(negative);
  if (std == null) return null;
  return std * Math.sqrt(365);
}

export async function getVaultPaused(client, vaultAddress) {
  try {
    const paused = await client.readContract({
      address: vaultAddress,
      abi: [{ inputs: [], name: 'paused', outputs: [{ type: 'bool' }], stateMutability: 'view', type: 'function' }],
      functionName: 'paused',
    });
    return !!paused;
  } catch (_) {
    return false;
  }
}

export function getEmergencyWithdrawFlag() {
  return false;
}

export async function getAssetDepegFlag(vaultConfig, options = {}) {
  const { getUnderlyingPrice } = options;
  if (!getUnderlyingPrice || !vaultConfig?.asset) return null;
  const price = await getUnderlyingPrice(vaultConfig);
  if (price == null) return null;
  const depegThreshold = 0.98;
  const isDepegged = price < depegThreshold;
  
  if (isDepegged) {
    console.warn(`[metrics] ${vaultConfig.id} asset DEPEGGED: $${price.toFixed(4)} (threshold: $${depegThreshold})`);
  }
  
  return isDepegged;
}
