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
  chainId: number,
  contractAddress?: Address
): Promise<string> {
  const verifyingContract = contractAddress || (process.env.NEXT_PUBLIC_DEPOSIT_ROUTER_ADDRESS as Address)
  
  if (!verifyingContract) {
    throw new Error('Contract address not set. Please configure NEXT_PUBLIC_DEPOSIT_ROUTER_ADDRESS in .env')
  }

  const domain = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract,
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

export async function getIntentHash(intent: DepositIntent, chainId: number): Promise<`0x${string}`> {
  const TYPEHASH = keccak256(
    new TextEncoder().encode(
      'DepositIntent(address user,address vault,address asset,uint256 amount,uint256 nonce,uint256 deadline)'
    )
  )
  
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
  
  return structHash
}

