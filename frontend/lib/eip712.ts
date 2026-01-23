import { Address } from 'viem'
import { signTypedData } from '@wagmi/core'
import { wagmiConfig } from '@/app/providers'
import { keccak256, encodePacked } from 'viem'

const DOMAIN_NAME = 'DepositRouter'
const DOMAIN_VERSION = '1'

const DEPOSIT_INTENT_TYPES = {
  DepositIntent: [
    { name: 'user', type: 'address' },
    { name: 'vault', type: 'address' },
    { name: 'asset', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export interface DepositIntent {
  user: Address
  vault: Address
  asset: Address
  amount: bigint
  nonce: bigint
  deadline: bigint
}

export async function signDepositIntent(
  intent: DepositIntent,
  chainId: number
): Promise<string> {
  const domain = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract: process.env.NEXT_PUBLIC_DEPOSIT_ROUTER_ADDRESS as Address,
  }

  const signature = await signTypedData(wagmiConfig, {
    domain,
    types: DEPOSIT_INTENT_TYPES,
    primaryType: 'DepositIntent',
    message: {
      user: intent.user,
      vault: intent.vault,
      asset: intent.asset,
      amount: intent.amount,
      nonce: intent.nonce,
      deadline: intent.deadline,
    },
  })

  return signature
}

// Utility function to compute intent hash (matches contract's keccak256)
export async function getIntentHash(intent: DepositIntent, chainId: number): Promise<`0x${string}`> {
  // This matches the contract's DEPOSIT_INTENT_TYPEHASH calculation
  const TYPEHASH = keccak256(
    new TextEncoder().encode(
      'DepositIntent(address user,address vault,address asset,uint256 amount,uint256 nonce,uint256 deadline)'
    )
  )
  
  // Encode the struct hash (same as contract does)
  const structHash = keccak256(
    encodePacked(
      ['bytes32', 'address', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      [
        TYPEHASH,
        intent.user,
        intent.vault,
        intent.asset,
        intent.amount,
        intent.nonce,
        intent.deadline,
      ]
    )
  )
  
  // Note: In the contract, this would be hashed with the domain separator
  // For now, we return the struct hash - the contract will compute the full hash
  // But we can use this to identify intents
  return structHash
}

