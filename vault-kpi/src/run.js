import * as S from './scoring.js';
import { fetchLagoonVaultData, getAprAsDecimal, isVaultPaused } from './lagoon-api.js';
import { runVaultAnalytics } from './vault-analytics.js';

export async function runVaultKPI({
  db,
  getClientForVault,
  VAULTS_CONFIG,
  getVaultById,
  options = {},
}) {
  const colVaultRatings = db.collection('vault_ratings');
  const colVaultRatingHistory = db.collection('vault_rating_history');

  const now = new Date();
  const results = [];

  for (const vaultConfig of VAULTS_CONFIG) {
    try {
      const client = getClientForVault(vaultConfig);
      const lagoonData = await fetchLagoonVaultData(vaultConfig);
      
      if (!lagoonData) {
        console.warn(`[vault-kpi] ${vaultConfig.id}: Lagoon API unavailable - skipping`);
        results.push({ vault_id: vaultConfig.id, error: 'Lagoon API unavailable' });
        continue;
      }

      const apr7d = getAprAsDecimal(lagoonData, 'weekly');
      const apr30d = getAprAsDecimal(lagoonData, 'monthly');
      const aprAll = getAprAsDecimal(lagoonData, 'inception');
      const aprBase = getAprAsDecimal(lagoonData, 'inceptionBase');

      let userAnalytics = null;
      if (client && options.includeUserAnalytics !== false) {
        try {
          userAnalytics = await runVaultAnalytics(client, vaultConfig);
        } catch (e) {
          console.warn(`[vault-kpi] ${vaultConfig.id}: User analytics failed:`, e.message);
        }
      }

      const metrics = {
        tvl: lagoonData.totalAssets,
        tvlUsd: lagoonData.totalAssetsUsd,
        totalSupply: lagoonData.totalSupply,
        apr7d,
        apr30d,
        aprAll,
        aprBase,
        pricePerShare: lagoonData.pricePerShare,
        pricePerShareUsd: lagoonData.pricePerShareUsd,
        highWaterMark: lagoonData.highWaterMark,
        vaultPaused: isVaultPaused(lagoonData),
        vaultState: lagoonData.vaultState,
        isWhitelistActivated: lagoonData.isWhitelistActivated,
        managementFee: lagoonData.managementFee,
        performanceFee: lagoonData.performanceFee,
        underlyingPrice: lagoonData.asset?.priceUsd,
        underlyingSymbol: lagoonData.asset?.symbol,
        underlyingDecimals: lagoonData.asset?.decimals,
        assetDepeg: lagoonData.asset?.priceUsd != null ? lagoonData.asset.priceUsd < 0.98 : null,
        lagoonName: lagoonData.name,
        lagoonSymbol: lagoonData.symbol,
        lagoonDescription: lagoonData.description,
        lagoonCurators: lagoonData.curators,
        lagoonVersion: lagoonData.version,
        hasAirdrops: lagoonData.hasAirdrops,
        hasIncentives: lagoonData.hasIncentives,
        logoUrl: lagoonData.logoUrl,
        userAnalytics: userAnalytics ? {
          totalUsers: userAnalytics.totalUsers,
          activeHolders: userAnalytics.activeHolders,
          exitedUsers: userAnalytics.exitedUsers,
          avgHoldingDays: userAnalytics.avgHoldingDays,
          medianHoldingDays: userAnalytics.medianHoldingDays,
          holdersOver30Days: userAnalytics.holdersOver30Days,
          holdersOver90Days: userAnalytics.holdersOver90Days,
          holdersOver180Days: userAnalytics.holdersOver180Days,
          quickExiters: userAnalytics.quickExiters,
          quickExitRate: userAnalytics.quickExitRate,
          retentionRate: userAnalytics.retentionRate,
          churnRate: userAnalytics.churnRate,
          avgDepositsPerUser: userAnalytics.avgDepositsPerUser,
          usersWithMultipleDeposits: userAnalytics.usersWithMultipleDeposits,
          trustScore: userAnalytics.trustScore,
          longTermHolders: userAnalytics.longTermHolders,
          smartDepositors: userAnalytics.smartDepositors,
          likelyFarmers: userAnalytics.likelyFarmers,
        } : null,
      };

      const score = S.compositeScoreLagoon(metrics, userAnalytics);
      const scoreBreakdown = {
        capital: S.capitalScoreLagoon(metrics),
        performance: S.performanceScoreLagoon(metrics),
        risk: S.riskScoreLagoon(metrics),
        userTrust: userAnalytics?.trustScore ?? null,
      };

      const aprPct = apr30d != null ? (apr30d * 100).toFixed(2) + '%' : 'N/A';
      const tvlFormatted = metrics.tvlUsd ? `$${(metrics.tvlUsd / 1e6).toFixed(2)}M` : 'N/A';
      const trustInfo = userAnalytics ? `, Trust=${userAnalytics.trustScore}, Users=${userAnalytics.totalUsers}` : '';
      console.log(`[vault-kpi] ${vaultConfig.id}: TVL=${tvlFormatted}, APR(30d)=${aprPct}, Score=${score?.toFixed(0) ?? 'N/A'}${trustInfo}`);

      const doc = {
        vault_id: vaultConfig.id,
        vault_name: lagoonData.name || vaultConfig.name,
        vault_address: vaultConfig.address,
        chain: vaultConfig.chain,
        asset_symbol: lagoonData.asset?.symbol ?? vaultConfig.asset?.symbol ?? 'USDC',
        metrics,
        score,
        score_breakdown: scoreBreakdown,
        updated_at: now,
        last_curated_at: now,
        lagoon_data: lagoonData,
      };

      await colVaultRatings.updateOne(
        { vault_id: vaultConfig.id, chain: vaultConfig.chain },
        { $set: doc },
        { upsert: true }
      );

      await colVaultRatingHistory.insertOne({
        vault_id: vaultConfig.id,
        chain: vaultConfig.chain,
        snapshot_at: now,
        metrics,
        score,
        score_breakdown: scoreBreakdown,
      });

      results.push({ vault_id: vaultConfig.id, score, updated_at: now });
    } catch (err) {
      console.error(`[vault-kpi] ${vaultConfig.id} error:`, err.message);
      results.push({ vault_id: vaultConfig.id, error: err.message });
    }
  }

  return results;
}
