import { Vault } from '@lagoon-protocol/v0-viem'
import { VaultUtils } from '@lagoon-protocol/v0-core'
import { createPublicClient, http, Address } from 'viem'
import { avalanche } from 'viem/chains'

const client = createPublicClient({
  chain: avalanche,
  transport: http(process.env.NEXT_PUBLIC_AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc'),
})

export async function fetchVault(address: Address) {
  try {
    const vault = await Vault.fetch(address, client)
    return vault
  } catch (error) {
    console.error('Failed to fetch vault:', error)
    throw error
  }
}

export async function getVaultAPR(
  vaultAddress: Address,
  startBlockNumber: bigint,
  endBlockNumber: bigint,
  decimals = 18
) {
  try {
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

export async function getVaultState(vaultAddress: Address) {
  const vault = await fetchVault(vaultAddress)
  
  if (!vault) {
    throw new Error('Failed to fetch vault')
  }
  
  const sharePrice = vault.totalSupply > BigInt(0) 
    ? vault.convertToAssets(VaultUtils.ONE_SHARE)
    : VaultUtils.ONE_SHARE
  
  const sharePriceFormatted = Number(sharePrice) / Number(BigInt(10) ** BigInt(vault.underlyingDecimals))
  
  return {
    // Basic info
    address: vaultAddress,
    name: vault.name || 'Lagoon Vault',
    symbol: vault.symbol || 'VAULT',
    asset: vault.asset,
    
    // Balances
    totalAssets: vault.totalAssets,
    totalSupply: vault.totalSupply,
    
    // Decimals
    decimals: vault.decimals,
    underlyingDecimals: vault.underlyingDecimals,
    
    // Epochs
    depositEpochId: vault.depositEpochId,
    redeemEpochId: vault.redeemEpochId,
    lastDepositEpochIdSettled: vault.lastDepositEpochIdSettled,
    lastRedeemEpochIdSettled: vault.lastRedeemEpochIdSettled,
    
    // Pricing
    sharePrice: sharePrice,
    sharePriceFormatted: sharePriceFormatted,
    
    // State
    state: vault.state,
    version: vault.version,
    
    // Additional vault info
    owner: vault.owner,
    feeReceiver: vault.feeReceiver,
    feeRates: vault.feeRates,
    highWaterMark: vault.highWaterMark,
    cooldown: vault.cooldown,
    isWhitelistActivated: vault.isWhitelistActivated,
  }
}

