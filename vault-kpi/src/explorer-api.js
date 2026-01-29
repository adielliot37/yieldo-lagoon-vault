const ROUTESCAN_BASE = 'https://api.routescan.io/v2/network/mainnet/evm';

const CHAIN_CONFIG = {
  ethereum: { chainId: 1 },
  avalanche: { chainId: 43114 },
};

function getRoutescanUrl(chain) {
  const config = CHAIN_CONFIG[chain];
  if (!config) return null;
  return `${ROUTESCAN_BASE}/${config.chainId}/etherscan/api`;
}

const DEFILLAMA_PRICE_URL = 'https://coins.llama.fi/prices/current';

function getRoutescanApiKey() {
  return process.env.ROUTESCAN_API_KEY || process.env.EXPLORER_API_KEY || '';
}

export async function getTokenSupply(vaultConfig) {
  const chain = (vaultConfig?.chain || '').toLowerCase();
  const baseUrl = getRoutescanUrl(chain);
  const contractaddress = vaultConfig?.asset?.address;
  
  if (!baseUrl || !contractaddress) return null;

  const apiKey = getRoutescanApiKey();
  for (const module of ['stats', 'token']) {
    const params = new URLSearchParams({
      module,
      action: 'tokensupply',
      contractaddress,
      ...(apiKey && { apikey: apiKey }),
    });
    const url = `${baseUrl}?${params.toString()}`;
    
    try {
      const res = await fetch(url);
      const data = await res.json();
      
      if (data?.status === '1' && data?.result != null && data.result !== '0') {
        console.log(`[explorer-api] ${chain} token supply: ${data.result} (module=${module})`);
        return String(data.result);
      }
      
      if (data?.message && data.message !== 'OK') {
        console.warn(`[explorer-api] ${chain} supply (module=${module}): ${data.message}`);
      }
    } catch (e) {
      console.warn(`[explorer-api] getTokenSupply ${chain} (module=${module}) failed:`, e.message);
    }
  }
  
  return null;
}

const DEFILLAMA_CHAIN_ID = {
  ethereum: 'ethereum',
  avalanche: 'avax',
};

export async function getUnderlyingPrice(vaultConfig) {
  const chain = (vaultConfig?.chain || '').toLowerCase();
  const address = vaultConfig?.asset?.address;
  if (!chain || !address) return null;
  const llamaChain = DEFILLAMA_CHAIN_ID[chain] || chain;
  const coinId = `${llamaChain}:${address}`;
  const url = `${DEFILLAMA_PRICE_URL}/${coinId}`;
  
  try {
    const res = await fetch(url);
    const data = await res.json();
    const coin = data?.coins?.[coinId];
    if (coin?.price != null) {
      console.log(`[explorer-api] ${vaultConfig.chain} USDC price: $${coin.price.toFixed(4)}`);
      return Number(coin.price);
    }
    console.warn(`[explorer-api] No price for ${coinId}`);
    return null;
  } catch (e) {
    console.warn(`[explorer-api] getUnderlyingPrice ${coinId} failed:`, e.message);
    return null;
  }
}
