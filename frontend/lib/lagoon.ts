import { Vault } from '@lagoon-protocol/v0-viem'
import { VaultUtils } from '@lagoon-protocol/v0-core'
import { createPublicClient, http, Address } from 'viem'
import { avalanche, mainnet } from 'viem/chains'
import { getVaultById } from './vaults-config'

const clients = {
  avalanche: createPublicClient({
    chain: avalanche,
    transport: http(process.env.NEXT_PUBLIC_AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc'),
  }),
  ethereum: createPublicClient({
    chain: mainnet,
    transport: http(process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL || 'https://1rpc.io/eth'),
  }),
}

export function getClientForChain(chain: 'avalanche' | 'ethereum') {
  return clients[chain]
}

export async function fetchVault(address: Address, chain: 'avalanche' | 'ethereum' = 'avalanche') {
  try {
    const client = getClientForChain(chain)
    const vault = await Vault.fetch(address, client)
    return vault
  } catch (error) {
    console.error(`Failed to fetch vault on ${chain}:`, error)
    throw error
  }
}

export async function getVaultAPR(
  vaultAddress: Address,
  startBlockNumber: bigint,
  endBlockNumber: bigint,
  chain: 'avalanche' | 'ethereum' = 'avalanche',
  decimals = 18
) {
  try {
    const client = getClientForChain(chain)
    const startBlock = await client.getBlock({ blockNumber: startBlockNumber })
    const endBlock = await client.getBlock({ blockNumber: endBlockNumber })

    const vaultStart = await Vault.fetch(vaultAddress, client, { blockNumber: startBlock.number })
    const vaultEnd = await Vault.fetch(vaultAddress, client, { blockNumber: endBlock.number })

    if (!vaultStart || !vaultEnd) {
      throw new Error('Failed to fetch vault state')
    }

    const basePrice = vaultStart.convertToAssets(VaultUtils.ONE_SHARE)
    const currentPrice = vaultEnd.convertToAssets(VaultUtils.ONE_SHARE)

    const periodSeconds = endBlock.timestamp - startBlock.timestamp
    const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n
    const BASIS_POINT = 10n ** BigInt(decimals + 2)

    const periodYield = ((currentPrice - basePrice) * SECONDS_PER_YEAR * BASIS_POINT)
    const apr = periodYield / (periodSeconds * basePrice)

    return apr
  } catch (error) {
    console.error('Failed to calculate APR:', error)
    throw error
  }
}

export async function getVaultState(vaultAddress: Address, chain: 'avalanche' | 'ethereum' = 'avalanche') {
  const vault = await fetchVault(vaultAddress, chain)
  
  if (!vault) {
    throw new Error('Failed to fetch vault')
  }
  
  const sharePrice = vault.totalSupply > BigInt(0) 
    ? vault.convertToAssets(VaultUtils.ONE_SHARE)
    : VaultUtils.ONE_SHARE
  
  const sharePriceFormatted = Number(sharePrice) / Number(BigInt(10) ** BigInt(vault.underlyingDecimals))
  
  return {
    address: vaultAddress,
    name: vault.name || 'Lagoon Vault',
    symbol: vault.symbol || 'VAULT',
    asset: vault.asset,
    totalAssets: vault.totalAssets,
    totalSupply: vault.totalSupply,
    decimals: vault.decimals,
    underlyingDecimals: vault.underlyingDecimals,
    depositEpochId: vault.depositEpochId,
    redeemEpochId: vault.redeemEpochId,
    lastDepositEpochIdSettled: vault.lastDepositEpochIdSettled,
    lastRedeemEpochIdSettled: vault.lastRedeemEpochIdSettled,
    sharePrice: sharePrice,
    sharePriceFormatted: sharePriceFormatted,
    state: vault.state,
    version: vault.version,
    owner: vault.owner,
    feeReceiver: vault.feeReceiver,
    feeRates: vault.feeRates,
    highWaterMark: vault.highWaterMark,
    cooldown: vault.cooldown,
    isWhitelistActivated: vault.isWhitelistActivated,
  }
}

