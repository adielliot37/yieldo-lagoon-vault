export interface VaultConfig {
  id: string;
  name: string;
  address: string;
  chain: 'avalanche' | 'ethereum' | 'polygon';
  chainId: number;
  asset: {
    address: string;
    symbol: string;
    decimals: number;
  };
  depositRouter?: string;
  hasSettlement: boolean;
}

export const VAULTS_CONFIG: VaultConfig[] = [
  {
    id: 'turtle-avalanche-usdc',
    name: 'Turtle Avalanche USDC',
    address: process.env.NEXT_PUBLIC_AVALANCHE_VAULT_ADDRESS || '0x3048925b3ea5a8c12eecccb8810f5f7544db54af',
    chain: 'avalanche',
    chainId: 43114,
    asset: {
      address: process.env.NEXT_PUBLIC_AVALANCHE_USDC_ADDRESS || '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      symbol: 'USDC',
      decimals: 6,
    },
    depositRouter: process.env.NEXT_PUBLIC_AVALANCHE_DEPOSIT_ROUTER_ADDRESS || process.env.NEXT_PUBLIC_DEPOSIT_ROUTER_ADDRESS,
    hasSettlement: false,
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
    depositRouter: process.env.NEXT_PUBLIC_ETHEREUM_DEPOSIT_ROUTER_ADDRESS,
    hasSettlement: true,
  },
];

export function getVaultById(id: string): VaultConfig | undefined {
  return VAULTS_CONFIG.find(v => v.id === id);
}

export function getVaultByAddress(address: string, chain: string): VaultConfig | undefined {
  return VAULTS_CONFIG.find(v => 
    v.address.toLowerCase() === address.toLowerCase() && v.chain === chain
  );
}

export function getVaultsByChain(chain: string): VaultConfig[] {
  return VAULTS_CONFIG.filter(v => v.chain === chain);
}

