import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });
dotenv.config({ path: join(__dirname, '.env') });

export const VAULTS_CONFIG = [
  {
    id: 'turtle-avalanche-usdc',
    name: 'Turtle Avalanche USDC',
    address: process.env.LAGOON_VAULT_ADDRESS || '0x3048925b3ea5a8c12eecccb8810f5f7544db54af',
    chain: 'avalanche',
    chainId: 43114,
    asset: {
      address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      symbol: 'USDC',
      decimals: 6,
    },
    rpcUrls: [
      process.env.AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc',
    ],
    safetyMargin: BigInt(process.env.AVALANCHE_SAFETY_MARGIN || '30'),
  },
  {
    id: '9summits-ethereum-usdc',
    name: '9Summits Flagship USDC',
    address: '0x03d1ec0d01b659b89a87eabb56e4af5cb6e14bfc',
    chain: 'ethereum',
    chainId: 1,
    asset: {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      decimals: 6,
    },
    rpcUrls: [
      ...(process.env.ETHEREUM_RPC_URL ? [process.env.ETHEREUM_RPC_URL] : []),
      'https://1rpc.io/eth',
      'https://rpc.ankr.com/eth',
      'https://eth-mainnet.public.blastapi.io',
      ...(process.env.ETHEREUM_RPC_URL ? [] : ['https://eth.llamarpc.com']),
    ],
    safetyMargin: BigInt(process.env.ETHEREUM_SAFETY_MARGIN || '10'),
  },
];

export function getVaultById(id) {
  return VAULTS_CONFIG.find(v => v.id === id);
}

export function getVaultByAddress(address, chain) {
  return VAULTS_CONFIG.find(v =>
    v.address.toLowerCase() === address.toLowerCase() && v.chain === chain
  );
}
