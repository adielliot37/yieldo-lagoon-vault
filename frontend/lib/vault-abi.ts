/**
 * ERC7540 / ERC4626 vault ABI fragments for redeem flow:
 * - maxRedeem(controller) = claimable shares after settlement
 * - maxWithdraw(controller) = claimable assets after settlement
 * - redeem(shares, receiver, controller) = claim assets (withdraw after settlement)
 */
export const VAULT_REDEEM_ABI = [
  {
    inputs: [{ name: 'controller', type: 'address' }],
    name: 'maxRedeem',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'controller', type: 'address' }],
    name: 'maxWithdraw',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'controller', type: 'address' },
    ],
    name: 'redeem',
    outputs: [{ name: 'assets', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const
