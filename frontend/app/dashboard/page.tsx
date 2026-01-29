'use client'

import { useAccount, useChainId, useReadContract, useWriteContract, useWaitForTransactionReceipt, useSwitchChain } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Address } from 'viem'
import { formatUnits } from 'viem'
import { VaultSelector } from '@/components/VaultSelector'
import { VAULTS_CONFIG, getVaultById } from '@/lib/vaults-config'
import { VAULT_REDEEM_ABI } from '@/lib/vault-abi'

interface DepositIntent {
  id: string
  user: string
  amount: string
  vault: string
  vault_id?: string
  vault_name?: string
  chain?: string
  asset_symbol?: string
  asset_decimals?: number
  status: 'pending' | 'executed' | 'confirmed' | 'settled' | 'requested'
  timestamp: string
  executed?: boolean
  source?: string
  txHash?: string
  epochId?: number
  shares?: string
}

interface Withdrawal {
  id: string
  user: string
  vault: string
  vault_id?: string
  vault_name?: string
  chain?: string
  asset_symbol?: string
  asset_decimals?: number
  shares: string
  assets: string | null
  epochId: number | null
  status: 'pending' | 'settled' | 'withdrawn'
  source: string
  timestamp: string
  settledAt: string | null
  blockNumber: string | null
  txHash: string | null
}

interface AUMData {
  user: string
  totalDepositsYieldo: string
  totalWithdrawalsYieldo: string
  aumFromYieldo: string
  combined?: boolean
  vaultBreakdown?: Array<{
    vault_id: string
    vault_name: string
    chain: string
    asset_symbol: string
    aum: string
    deposits: string
    withdrawals: string
  }>
  breakdown: {
    deposits: number
    withdrawalsYieldo: number
  }
}

interface Snapshot {
  date: string
  vault_id?: string
  vault_name?: string
  chain?: string
  asset_symbol?: string
  aum?: string
  total_assets?: string
  totalDeposits?: string
  total_deposits?: string
  totalWithdrawals?: string
  total_withdrawals?: string
  vaults?: Array<{
    vault_id: string
    vault_name: string
    chain: string
    asset_symbol: string
  }>
}

const formatToken = (amount: string | number | undefined | null, decimals: number = 6): string => {
  if (amount === undefined || amount === null || amount === '') {
    return '0.00'
  }
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  if (isNaN(num)) {
    return '0.00'
  }
  if (num > 1000) {
    return (num / (10 ** decimals)).toFixed(2)
  }
  return num.toFixed(2)
}

const formatUSDC = (amount: string | number | undefined | null): string => {
  return formatToken(amount, 6)
}

const formatShares = (shares: string | number | undefined | null): string => {
  if (shares === undefined || shares === null || shares === '') {
    return '0.00'
  }
  
  let sharesBigInt: bigint
  try {
    sharesBigInt = typeof shares === 'string' ? BigInt(shares) : BigInt(Math.floor(shares))
  } catch {
    return '0.00'
  }
  
  if (sharesBigInt === 0n) {
    return '0.00'
  }
  
  const divisor = BigInt(10) ** BigInt(18)
  const wholePart = sharesBigInt / divisor
  const fractionalPart = sharesBigInt % divisor
  
  const fractionalDecimal = Number(fractionalPart) / Number(divisor)
  const total = Number(wholePart) + fractionalDecimal
  
  return total.toFixed(3).replace(/\.?0+$/, '')
}

interface VaultDataCache {
  deposits: DepositIntent[]
  withdrawals: Withdrawal[]
  aum: AUMData | null
}

export default function Dashboard() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  const [dataCache, setDataCache] = useState<Map<string, VaultDataCache>>(new Map())
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedVaultId, setSelectedVaultId] = useState<string | null>('combined')
  const [initialLoadComplete, setInitialLoadComplete] = useState(false)
  const [claimWithdrawLoading, setClaimWithdrawLoading] = useState(false)

  const selectedVault = selectedVaultId && selectedVaultId !== 'combined' ? getVaultById(selectedVaultId) : null
  const chainMatchesVault = selectedVault ? chainId === selectedVault.chainId : false

  const { data: claimableShares, refetch: refetchClaimable } = useReadContract({
    address: selectedVault?.address as Address | undefined,
    abi: VAULT_REDEEM_ABI,
    functionName: 'maxRedeem',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!selectedVault && chainMatchesVault },
  })
  const { data: claimableAssets } = useReadContract({
    address: selectedVault?.address as Address | undefined,
    abi: VAULT_REDEEM_ABI,
    functionName: 'maxWithdraw',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!selectedVault && chainMatchesVault },
  })

  const { writeContract: writeRedeem, data: redeemHash, isPending: isRedeemPending, reset: resetRedeem, error: writeRedeemError } = useWriteContract()
  const { isSuccess: isRedeemSuccess } = useWaitForTransactionReceipt({ hash: redeemHash })

  useEffect(() => {
    if (writeRedeemError) setClaimWithdrawLoading(false)
  }, [writeRedeemError])

  useEffect(() => {
    if (isRedeemSuccess && redeemHash) {
      setClaimWithdrawLoading(false)
      resetRedeem()
      refetchClaimable()
      loadAllVaultData()
    }
  }, [isRedeemSuccess, redeemHash])

  const handleClaimWithdraw = () => {
    if (!address || !selectedVault || claimableShares === undefined || claimableShares === 0n) return
    setClaimWithdrawLoading(true)
    writeRedeem({
      address: selectedVault.address as Address,
      abi: VAULT_REDEEM_ABI,
      functionName: 'redeem',
      args: [claimableShares, address, address],
    })
  }

  const ITEMS_PER_PAGE = 5
  const [depositsPage, setDepositsPage] = useState(1)
  const [withdrawalsPage, setWithdrawalsPage] = useState(1)
  const [snapshotsPage, setSnapshotsPage] = useState(1)

  useEffect(() => {
    if (isConnected && address && !initialLoadComplete) {
      loadAllVaultData()
    }
  }, [isConnected, address, initialLoadComplete])

  const deposits = selectedVaultId ? (dataCache.get(selectedVaultId)?.deposits || []) : []
  const withdrawals = selectedVaultId ? (dataCache.get(selectedVaultId)?.withdrawals || []) : []
  const aumData = selectedVaultId ? (dataCache.get(selectedVaultId)?.aum || null) : null

  useEffect(() => {
    setDepositsPage(1)
    setWithdrawalsPage(1)
    setSnapshotsPage(1)
  }, [selectedVaultId])

  const depositsPaginated = deposits.slice((depositsPage - 1) * ITEMS_PER_PAGE, depositsPage * ITEMS_PER_PAGE)
  const withdrawalsPaginated = withdrawals.slice((withdrawalsPage - 1) * ITEMS_PER_PAGE, withdrawalsPage * ITEMS_PER_PAGE)
  const snapshotsPaginated = snapshots.slice((snapshotsPage - 1) * ITEMS_PER_PAGE, snapshotsPage * ITEMS_PER_PAGE)

  const depositsTotalPages = Math.ceil(deposits.length / ITEMS_PER_PAGE) || 1
  const withdrawalsTotalPages = Math.ceil(withdrawals.length / ITEMS_PER_PAGE) || 1
  const snapshotsTotalPages = Math.ceil(snapshots.length / ITEMS_PER_PAGE) || 1

  const loadAllVaultData = async () => {
    if (!address) return
    
    try {
      setLoading(true)
      const apiUrl = (process.env.NEXT_PUBLIC_INDEXER_API_URL || 'http://localhost:3001').replace(/\/$/, '')
      const cache = new Map<string, VaultDataCache>()
      cache.set('combined', { deposits: [], withdrawals: [], aum: null })
      VAULTS_CONFIG.forEach(vault => {
        cache.set(vault.id, { deposits: [], withdrawals: [], aum: null })
      })

      const apiCalls: Promise<void>[] = []
      apiCalls.push(
        Promise.all([
          fetch(`${apiUrl}/api/deposits?user=${address}`),
          fetch(`${apiUrl}/api/withdrawals?user=${address}`),
          fetch(`${apiUrl}/api/aum?user=${address}&combined=true`)
        ]).then(async ([depositsRes, withdrawalsRes, aumRes]) => {
          const current = cache.get('combined')!
          const updates: Partial<VaultDataCache> = {}
          
          if (depositsRes.ok) {
            updates.deposits = await depositsRes.json()
          }
          if (withdrawalsRes.ok) {
            updates.withdrawals = await withdrawalsRes.json()
          }
          if (aumRes.ok) {
            updates.aum = await aumRes.json()
          }
          
          cache.set('combined', { ...current, ...updates })
        })
      )

      VAULTS_CONFIG.forEach(vault => {
        apiCalls.push(
          Promise.all([
            fetch(`${apiUrl}/api/deposits?user=${address}&vault_id=${vault.id}&chain=${vault.chain}`),
            fetch(`${apiUrl}/api/withdrawals?user=${address}&vault_id=${vault.id}&chain=${vault.chain}`),
            fetch(`${apiUrl}/api/aum?user=${address}&vault_id=${vault.id}&chain=${vault.chain}`)
          ]).then(async ([depositsRes, withdrawalsRes, aumRes]) => {
            const current = cache.get(vault.id)!
            const updates: Partial<VaultDataCache> = {}
            
            if (depositsRes.ok) {
              updates.deposits = await depositsRes.json()
            }
            if (withdrawalsRes.ok) {
              updates.withdrawals = await withdrawalsRes.json()
            }
            if (aumRes.ok) {
              updates.aum = await aumRes.json()
            }
            
            cache.set(vault.id, { ...current, ...updates })
          })
        )
      })

      apiCalls.push(
        fetch(`${apiUrl}/api/snapshots?combined=true`)
          .then(async (res) => {
            if (res.ok) {
              const data = await res.json()
              setSnapshots(data)
            }
          })
      )

      await Promise.all(apiCalls)
      setDataCache(cache)
      setInitialLoadComplete(true)
    } catch (error) {
      console.error('Failed to fetch data:', error)
    } finally {
      setLoading(false)
    }
  }

  if (!isConnected) {
    return (
      <main className="min-h-screen bg-white text-black">
        <nav className="border-b border-black px-6 py-4">
          <div className="max-w-7xl mx-auto flex justify-between items-center">
            <Link href="/" className="text-2xl font-bold">Yieldo</Link>
            <ConnectButton />
          </div>
        </nav>
        <div className="max-w-7xl mx-auto px-6 py-12 text-center">
          <h2 className="text-3xl font-bold mb-4">Please connect your wallet</h2>
          <ConnectButton />
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-white text-black">
      <nav className="border-b border-black px-6 py-4">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <Link href="/" className="text-2xl font-bold">Yieldo</Link>
          <ConnectButton />
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-6 py-12">
        <h1 className="text-4xl font-bold mb-8">Dashboard</h1>

        <VaultSelector 
          selectedVaultId={selectedVaultId} 
          onVaultChange={setSelectedVaultId}
          showCombined={true}
        />
        {aumData && (
          <div className="border-2 border-black p-6 mb-8 bg-gray-50">
            <h2 className="text-2xl font-bold mb-4">
              {selectedVaultId === 'combined' ? 'Total AUM (All Vaults)' : 'Your AUM (Assets Under Management)'}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
              <div className="border border-gray-300 p-4 bg-white">
                <p className="text-sm text-gray-600 mb-1">Total Deposits (Yieldo)</p>
                <p className="text-2xl font-bold">{formatUSDC(aumData.totalDepositsYieldo)} USDC</p>
              </div>
              <div className="border border-gray-300 p-4 bg-white">
                <p className="text-sm text-gray-600 mb-1">Withdrawals (Yieldo)</p>
                <p className="text-2xl font-bold">{formatUSDC(aumData.totalWithdrawalsYieldo)} USDC</p>
              </div>
              <div className="border border-gray-300 p-4 bg-white">
                <p className="text-sm text-gray-600 mb-1">Total Transactions</p>
                <p className="text-2xl font-bold">
                  {aumData.breakdown.deposits + aumData.breakdown.withdrawalsYieldo}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {aumData.breakdown.deposits} deposits, {aumData.breakdown.withdrawalsYieldo} withdrawals
                </p>
              </div>
              <div className="border-2 border-black p-4 bg-white">
                <p className="text-sm text-gray-600 mb-1">AUM (Yieldo)</p>
                <p className="text-3xl font-bold text-green-600">{formatUSDC(aumData.aumFromYieldo)} USDC</p>
                <p className="text-xs text-gray-500 mt-1">Deposits - Withdrawals (Yieldo)</p>
              </div>
            </div>
            {aumData.combined && aumData.vaultBreakdown && aumData.vaultBreakdown.length > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-300">
                <p className="text-sm font-semibold mb-2">AUM by Vault:</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {aumData.vaultBreakdown.map((vault) => (
                    <div key={vault.vault_id} className="border border-gray-300 p-3 bg-white">
                      <p className="text-sm font-semibold">{vault.vault_name}</p>
                      <p className="text-xs text-gray-600">{vault.chain} • {vault.asset_symbol}</p>
                      <p className="text-lg font-bold mt-1">{formatToken(vault.aum, 6)} {vault.asset_symbol}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            <div className="mt-4 pt-4 border-t border-gray-300">
              <p className="text-xs text-gray-400 italic">
                AUM = Deposits through Yieldo - Withdrawals through Yieldo
              </p>
            </div>
          </div>
        )}

        {selectedVault && (
          <div className="border-2 border-black p-6 mb-8 bg-gray-50">
            <h2 className="text-xl font-bold mb-2">Assets available to withdraw</h2>
            {!chainMatchesVault ? (
              <p className="text-gray-600 mb-3">
                Select vault &quot;{selectedVault.name}&quot; above and switch your wallet to {selectedVault.chain} to see claimable assets and withdraw.
              </p>
            ) : claimableShares !== undefined && claimableAssets !== undefined && claimableShares > 0n ? (
              <>
                <p className="text-gray-700 mb-2">
                  <span className="font-semibold">{formatUnits(claimableAssets, selectedVault.asset.decimals)} {selectedVault.asset.symbol}</span>
                  {' '}({selectedVault.name})
                </p>
                <p className="text-sm text-green-700 mb-3">Redemption complete. You can now withdraw your underlying assets.</p>
                <button
                  onClick={handleClaimWithdraw}
                  disabled={claimWithdrawLoading || isRedeemPending || claimableShares === 0n}
                  className="bg-green-600 text-white py-2 px-4 font-semibold hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                  {claimWithdrawLoading || isRedeemPending ? 'Withdrawing...' : 'Withdraw'}
                </button>
              </>
            ) : (
              <p className="text-gray-600">No assets ready to withdraw for this vault. Pending redemptions will appear here after settlement.</p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
          <div className="border-2 border-black p-6">
            <h2 className="text-2xl font-bold mb-4">Your Deposits</h2>
            {loading ? (
              <p className="text-gray-700">Loading...</p>
            ) : deposits.length === 0 ? (
              <p className="text-gray-700">No deposits found</p>
            ) : (
              <>
              <div className="space-y-4">
                {depositsPaginated.map((deposit) => {
                  const decimals = deposit.asset_decimals || 6
                  const symbol = deposit.asset_symbol || 'USDC'
                  return (
                    <div key={deposit.id} className="border border-gray-300 p-4">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <span className="font-semibold text-lg">{formatToken(deposit.amount, decimals)} {symbol}</span>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {deposit.source && (
                              <span className={`text-xs px-2 py-1 rounded ${
                                deposit.source === 'yieldo' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'
                              }`}>
                                {deposit.source === 'yieldo' ? 'Yieldo' : 'Lagoon'}
                              </span>
                            )}
                            {deposit.vault_name && (
                              <span className="text-xs px-2 py-1 rounded bg-purple-100 text-purple-800">
                                {deposit.vault_name}
                              </span>
                            )}
                            {deposit.chain && (
                              <span className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-800">
                                {deposit.chain}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className={`text-sm px-2 py-1 rounded ${
                          deposit.status === 'settled' || deposit.status === 'executed' ? 'bg-green-600 text-white' :
                          deposit.status === 'requested' ? 'bg-orange-100 text-orange-800' :
                          deposit.status === 'confirmed' ? 'bg-blue-500 text-white' :
                          'bg-yellow-100 text-yellow-800'
                        }`}>
                          {deposit.status === 'executed' ? '✅ Executed' : 
                           deposit.status === 'settled' ? '✅ Settled' :
                           deposit.status === 'requested' ? '⏳ Requested' :
                           deposit.status}
                        </span>
                      </div>
                      <div className="text-sm text-gray-600 space-y-1 mt-2">
                        <p>{new Date(deposit.timestamp).toLocaleString()}</p>
                      {deposit.txHash && (
                        <p className="text-xs">
                          <a 
                            href={deposit.chain === 'ethereum' 
                              ? `https://etherscan.io/tx/${deposit.txHash}`
                              : `https://snowtrace.io/tx/${deposit.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline break-all"
                          >
                            Tx: {deposit.txHash.slice(0, 10)}...{deposit.txHash.slice(-8)}
                          </a>
                        </p>
                      )}
                      {deposit.epochId !== null && deposit.epochId !== undefined && (
                        <p className="text-xs">Epoch: {deposit.epochId}</p>
                      )}
                        {deposit.shares && (
                          <p className="text-xs">Shares: {formatShares(deposit.shares)}</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-300">
                <button
                  onClick={() => setDepositsPage(p => Math.max(1, p - 1))}
                  disabled={depositsPage <= 1}
                  className="px-3 py-1.5 border border-black disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-100 rounded text-sm"
                >
                  Previous
                </button>
                <span className="text-sm text-gray-600">
                  Page {depositsPage} of {depositsTotalPages}
                </span>
                <button
                  onClick={() => setDepositsPage(p => Math.min(depositsTotalPages, p + 1))}
                  disabled={depositsPage >= depositsTotalPages}
                  className="px-3 py-1.5 border border-black disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-100 rounded text-sm"
                >
                  Next
                </button>
              </div>
              </>
            )}
          </div>

          <div className="border-2 border-black p-6">
            <h2 className="text-2xl font-bold mb-4">Your Withdrawals</h2>
            {loading ? (
              <p className="text-gray-700">Loading...</p>
            ) : withdrawals.length === 0 ? (
              <p className="text-gray-700">No withdrawals found</p>
            ) : (
              <>
              <div className="space-y-4">
                {withdrawalsPaginated.map((withdrawal) => {
                  const decimals = withdrawal.asset_decimals || 6
                  const symbol = withdrawal.asset_symbol || 'USDC'
                  return (
                    <div key={withdrawal.id} className="border border-gray-300 p-4">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <span className="font-semibold text-lg">
                            {withdrawal.assets ? formatToken(withdrawal.assets, decimals) : 'Pending...'} {symbol}
                          </span>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {withdrawal.source && (
                              <span className={`text-xs px-2 py-1 rounded ${
                                withdrawal.source === 'yieldo' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'
                              }`}>
                                {withdrawal.source === 'yieldo' ? 'Yieldo' : 'Lagoon'}
                              </span>
                            )}
                            {withdrawal.vault_name && (
                              <span className="text-xs px-2 py-1 rounded bg-purple-100 text-purple-800">
                                {withdrawal.vault_name}
                              </span>
                            )}
                            {withdrawal.chain && (
                              <span className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-800">
                                {withdrawal.chain}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className={`text-sm px-2 py-1 rounded ${
                          withdrawal.status === 'withdrawn' ? 'bg-gray-600 text-white' :
                          withdrawal.status === 'settled' ? 'bg-green-600 text-white' :
                          'bg-yellow-100 text-yellow-800'
                        }`}>
                          {withdrawal.status === 'withdrawn' ? '✅ Withdrawn' : withdrawal.status === 'settled' ? 'Ready to withdraw' : '⏳ Pending'}
                        </span>
                      </div>
                      <div className="text-sm text-gray-600 space-y-1 mt-2">
                        <p>Shares: {formatShares(withdrawal.shares)}</p>
                      <p>{new Date(withdrawal.timestamp).toLocaleString()}</p>
                      {withdrawal.txHash && (
                        <p className="text-xs">
                          <a 
                            href={withdrawal.chain === 'ethereum' 
                              ? `https://etherscan.io/tx/${withdrawal.txHash}`
                              : `https://snowtrace.io/tx/${withdrawal.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline break-all"
                          >
                            Tx: {withdrawal.txHash.slice(0, 10)}...{withdrawal.txHash.slice(-8)}
                          </a>
                        </p>
                      )}
                      {withdrawal.epochId !== null && withdrawal.epochId !== undefined && (
                        <p className="text-xs">Epoch: {withdrawal.epochId}</p>
                      )}
                      {withdrawal.settledAt && (
                        <p className="text-xs text-green-600">Settled: {new Date(withdrawal.settledAt).toLocaleString()}</p>
                      )}
                        {withdrawal.status === 'pending' && (
                          <p className="text-xs text-yellow-600">⏳ Waiting for settlement...</p>
                        )}
                        {withdrawal.status === 'settled' && (
                          <p className="text-xs text-green-600">Redemption complete. Use &quot;Assets available to withdraw&quot; above to claim.</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-300">
                <button
                  onClick={() => setWithdrawalsPage(p => Math.max(1, p - 1))}
                  disabled={withdrawalsPage <= 1}
                  className="px-3 py-1.5 border border-black disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-100 rounded text-sm"
                >
                  Previous
                </button>
                <span className="text-sm text-gray-600">
                  Page {withdrawalsPage} of {withdrawalsTotalPages}
                </span>
                <button
                  onClick={() => setWithdrawalsPage(p => Math.min(withdrawalsTotalPages, p + 1))}
                  disabled={withdrawalsPage >= withdrawalsTotalPages}
                  className="px-3 py-1.5 border border-black disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-100 rounded text-sm"
                >
                  Next
                </button>
              </div>
              </>
            )}
          </div>

          <div className="border-2 border-black p-6">
            <h2 className="text-2xl font-bold mb-4">Daily Snapshots (Yieldo Protocol)</h2>
            <p className="text-sm text-gray-500 mb-4">
              Daily totals of deposits and withdrawals made through the Yieldo protocol only. Values are in USDC (6 decimals).
            </p>
            {loading ? (
              <p className="text-gray-700">Loading...</p>
            ) : snapshots.length === 0 ? (
              <p className="text-gray-500 italic">No snapshots yet. Snapshots are generated daily by the indexer.</p>
            ) : (
              <>
              <div className="space-y-4">
                {snapshotsPaginated.map((snapshot) => {
                  const aum = snapshot.total_assets || snapshot.aum || '0'
                  const snapshotDeposits = snapshot.total_deposits || snapshot.totalDeposits || '0'
                  const snapshotWithdrawals = snapshot.total_withdrawals || snapshot.totalWithdrawals || '0'
                  return (
                    <div key={snapshot.date} className="border border-gray-300 p-4">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <span className="font-semibold">{snapshot.date}</span>
                          {snapshot.vaults && snapshot.vaults.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {snapshot.vaults.map((v, i) => (
                                <span key={i} className="text-xs px-2 py-1 rounded bg-purple-100 text-purple-800">
                                  {v.vault_name} ({v.chain})
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <span className="text-lg font-bold">{formatUSDC(aum)} USDC</span>
                      </div>
                      <div className="text-sm text-gray-600 space-y-1">
                        <p>Deposits: {formatUSDC(snapshotDeposits)} USDC</p>
                        <p>Withdrawals: {formatUSDC(snapshotWithdrawals)} USDC</p>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-300">
                <button
                  onClick={() => setSnapshotsPage(p => Math.max(1, p - 1))}
                  disabled={snapshotsPage <= 1}
                  className="px-3 py-1.5 border border-black disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-100 rounded text-sm"
                >
                  Previous
                </button>
                <span className="text-sm text-gray-600">
                  Page {snapshotsPage} of {snapshotsTotalPages}
                </span>
                <button
                  onClick={() => setSnapshotsPage(p => Math.min(snapshotsTotalPages, p + 1))}
                  disabled={snapshotsPage >= snapshotsTotalPages}
                  className="px-3 py-1.5 border border-black disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-100 rounded text-sm"
                >
                  Next
                </button>
              </div>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}


