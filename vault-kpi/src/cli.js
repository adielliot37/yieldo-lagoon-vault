import { MongoClient } from 'mongodb';
import { createPublicClient, http } from 'viem';
import { avalanche, mainnet } from 'viem/chains';
import { VAULTS_CONFIG, getVaultById } from '../vaults-config.js';
import { runVaultKPI } from './run.js';
import { getUnderlyingPrice, getTokenSupply } from './explorer-api.js';

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'yieldo';

const avalancheRpc = process.env.AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc';
const ethereumRpc = process.env.ETHEREUM_RPC_URL || 'https://1rpc.io/eth';

const clients = {
  avalanche: createPublicClient({
    chain: avalanche,
    transport: http(avalancheRpc),
  }),
  ethereum: createPublicClient({
    chain: mainnet,
    transport: http(ethereumRpc),
  }),
};

function getClientForVault(vaultConfig) {
  return clients[vaultConfig.chain];
}

async function main() {
  if (!MONGODB_URI) {
    console.error('Missing MONGODB_URI. Set it in .env at project root.');
    process.exit(1);
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB_NAME);
  try {
    const results = await runVaultKPI({
      db,
      getClientForVault,
      VAULTS_CONFIG,
      getVaultById,
      options: { getUnderlyingPrice, getTokenSupply },
    });
    console.log('Vault KPI job completed:', results.length, 'vault(s)');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
