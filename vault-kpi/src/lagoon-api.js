const LAGOON_API_BASE = 'https://app.lagoon.finance/api/vault';

const CHAIN_ID_MAP = {
  ethereum: 1,
  avalanche: 43114,
};

export async function fetchLagoonVaultData(vaultConfig) {
  const chain = (vaultConfig?.chain || '').toLowerCase();
  const chainId = CHAIN_ID_MAP[chain];
  const address = vaultConfig?.address;

  if (!chainId || !address) {
    console.warn(`[lagoon-api] Missing chainId or address for ${vaultConfig?.id}`);
    return null;
  }

  const url = `${LAGOON_API_BASE}?chainId=${chainId}&address=${address.toLowerCase()}&includeApr=true`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[lagoon-api] ${vaultConfig.id}: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    
    if (!data || !data.state) {
      console.warn(`[lagoon-api] ${vaultConfig.id}: Invalid response`);
      return null;
    }

    const result = {
      name: data.name,
      symbol: data.symbol,
      description: data.shortDescription,
      logoUrl: data.logoUrl,
      asset: {
        symbol: data.asset?.symbol,
        decimals: data.asset?.decimals,
        priceUsd: data.asset?.priceUsd,
      },
      totalAssets: data.state.totalAssets?.toString(),
      totalAssetsUsd: data.state.totalAssetsUsd,
      totalSupply: data.state.totalSupply,
      pricePerShare: data.state.pricePerShare,
      pricePerShareUsd: data.state.pricePerShareUsd,
      apr: {
        weekly: data.state.weeklyApr?.linearNetApr ?? null,
        monthly: data.state.monthlyApr?.linearNetApr ?? null,
        inception: data.state.inceptionApr?.linearNetApr ?? null,
        weeklyBase: data.state.weeklyApr?.linearNetAprWithoutExtraYields ?? null,
        monthlyBase: data.state.monthlyApr?.linearNetAprWithoutExtraYields ?? null,
        inceptionBase: data.state.inceptionApr?.linearNetAprWithoutExtraYields ?? null,
      },
      managementFee: data.state.managementFee,
      performanceFee: data.state.performanceFee,
      vaultState: data.state.state,
      version: data.state.version,
      curators: data.curators?.map(c => c.name) || [],
      hasAirdrops: (data.airdrops?.length || 0) > 0,
      hasIncentives: (data.state.inceptionApr?.incentives?.length || 0) > 0,
      highWaterMark: data.state.highWaterMark,
      isWhitelistActivated: data.state.isWhitelistActivated,
      _raw: data,
    };

    console.log(`[lagoon-api] ${vaultConfig.id}: TVL=$${(result.totalAssetsUsd / 1e6).toFixed(2)}M, APR(7d)=${result.apr.weekly?.toFixed(2) ?? 'N/A'}%, APR(30d)=${result.apr.monthly?.toFixed(2) ?? 'N/A'}%`);

    return result;
  } catch (e) {
    console.error(`[lagoon-api] ${vaultConfig.id}: Failed to fetch:`, e.message);
    return null;
  }
}

export function getAprAsDecimal(lagoonData, period = 'monthly') {
  const aprPct = lagoonData?.apr?.[period];
  if (aprPct == null || isNaN(aprPct)) return null;
  return aprPct / 100;
}

export function isVaultPaused(lagoonData) {
  const state = lagoonData?.vaultState?.toLowerCase();
  return state === 'paused' || state === 'closed';
}
