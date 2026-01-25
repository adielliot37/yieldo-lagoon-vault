'use client'

import { useAccount } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useEffect, useState } from 'react'
import Link from 'next/link'

interface DepositIntent {
  id: string
  user: string
  amount: string
  vault: string
  status: 'pending' | 'executed' | 'confirmed' | 'settled'
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
  shares: string
  assets: string | null
  epochId: number | null
  status: 'pending' | 'settled'
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
  totalWithdrawalsLagoon: string
  aumFromYieldo: string
  currentVaultBalance: string
  hasDirectWithdrawals: boolean
  directWithdrawalAmount: string
  breakdown: {
    deposits: number
    withdrawalsYieldo: number
    withdrawalsLagoon: number
  }
}

interface Snapshot {
  date: string
  aum: string
  totalDeposits: string
  totalWithdrawals: string
}

const formatUSDC = (amount: string | number | undefined | null): string => {
  if (amount === undefined || amount === null || amount === '') {
    return '0.00'
  }
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  if (isNaN(num)) {
    return '0.00'
  }
  if (num > 1000) {
    return (num / 1e6).toFixed(2)
  }
  return num.toFixed(2)
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

export default function Dashboard() {
  const { address, isConnected } = useAccount()
  const [deposits, setDeposits] = useState<DepositIntent[]>([])
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([])
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [aumData, setAumData] = useState<AUMData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (isConnected && address) {
      fetchUserData()
    }
  }, [isConnected, address])

  const fetchUserData = async () => {
    try {
      const apiUrl = (process.env.NEXT_PUBLIC_INDEXER_API_URL || 'http://localhost:3001').replace(/\/$/, '')
      const [depositsRes, withdrawalsRes, snapshotsRes, aumRes] = await Promise.all([
        fetch(`${apiUrl}/api/deposits?user=${address}`),
        fetch(`${apiUrl}/api/withdrawals?user=${address}`),
        fetch(`${apiUrl}/api/snapshots`),
        fetch(`${apiUrl}/api/aum?user=${address}`)
      ])
      
      if (depositsRes.ok) {
        const depositsData = await depositsRes.json()
        setDeposits(depositsData)
      }
      
      if (withdrawalsRes.ok) {
        const withdrawalsData = await withdrawalsRes.json()
        setWithdrawals(withdrawalsData)
      }
      
      if (snapshotsRes.ok) {
        const snapshotsData = await snapshotsRes.json()
        setSnapshots(snapshotsData)
      }

      if (aumRes.ok) {
        const aumData = await aumRes.json()
        setAumData(aumData)
      }
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

        {/* AUM Section */}
        {aumData && (
          <div className="border-2 border-black p-6 mb-8 bg-gray-50">
            <h2 className="text-2xl font-bold mb-4">Your AUM (Assets Under Management)</h2>
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
                <p className="text-sm text-gray-600 mb-1">Withdrawals (Lagoon)</p>
                <p className="text-2xl font-bold">
                  {formatUSDC(aumData.totalWithdrawalsLagoon || '0')} USDC
                </p>
                {withdrawals.some(w => w.source === 'lagoon' && w.status === 'pending') && (
                  <p className="text-xs text-yellow-600 mt-1">⚠️ Includes pending withdrawals</p>
                )}
              </div>
              <div className="border-2 border-black p-4 bg-white">
                <p className="text-sm text-gray-600 mb-1">AUM (Yieldo)</p>
                <p className="text-3xl font-bold text-green-600">{formatUSDC(aumData.aumFromYieldo)} USDC</p>
                <p className="text-xs text-gray-500 mt-1">Deposits - Withdrawals (Yieldo)</p>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-gray-300">
              <p className="text-sm text-gray-600">
                Current Vault Balance: <span className="font-semibold">{formatUSDC(aumData.currentVaultBalance)} USDC</span>
              </p>
              <p className="text-xs text-gray-500 mt-2">
                Breakdown: {aumData.breakdown.deposits} deposits (Yieldo), {aumData.breakdown.withdrawalsYieldo} withdrawals (Yieldo), {aumData.breakdown.withdrawalsLagoon} withdrawals (Lagoon)
              </p>
              <p className="text-xs text-gray-400 mt-1 italic">
                AUM = Deposits through Yieldo - Withdrawals through Yieldo
              </p>
            </div>
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
              <div className="space-y-4">
                {deposits.map((deposit) => (
                  <div key={deposit.id} className="border border-gray-300 p-4">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <span className="font-semibold text-lg">{formatUSDC(deposit.amount)} USDC</span>
                        {deposit.source && (
                          <span className={`ml-2 text-xs px-2 py-1 rounded ${
                            deposit.source === 'yieldo' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'
                          }`}>
                            {deposit.source === 'yieldo' ? 'Yieldo' : 'Lagoon'}
                          </span>
                        )}
                      </div>
                      <span className={`text-sm px-2 py-1 rounded ${
                        deposit.status === 'settled' || deposit.status === 'executed' ? 'bg-green-600 text-white' :
                        deposit.status === 'confirmed' ? 'bg-blue-500 text-white' :
                        'bg-yellow-100 text-yellow-800'
                      }`}>
                        {deposit.status === 'executed' ? '✅ Executed' : deposit.status}
                      </span>
                    </div>
                    <div className="text-sm text-gray-600 space-y-1 mt-2">
                      <p>{new Date(deposit.timestamp).toLocaleString()}</p>
                      {deposit.txHash && (
                        <p className="text-xs">
                          <a 
                            href={`https://snowtrace.io/tx/${deposit.txHash}`}
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
                ))}
              </div>
            )}
          </div>

          <div className="border-2 border-black p-6">
            <h2 className="text-2xl font-bold mb-4">Your Withdrawals</h2>
            {loading ? (
              <p className="text-gray-700">Loading...</p>
            ) : withdrawals.length === 0 ? (
              <p className="text-gray-700">No withdrawals found</p>
            ) : (
              <div className="space-y-4">
                {withdrawals.map((withdrawal) => (
                  <div key={withdrawal.id} className="border border-gray-300 p-4">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <span className="font-semibold text-lg">
                          {withdrawal.assets ? formatUSDC(withdrawal.assets) : 'Pending...'} USDC
                        </span>
                        {withdrawal.source && (
                          <span className={`ml-2 text-xs px-2 py-1 rounded ${
                            withdrawal.source === 'yieldo' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'
                          }`}>
                            {withdrawal.source === 'yieldo' ? 'Yieldo' : 'Lagoon'}
                          </span>
                        )}
                      </div>
                      <span className={`text-sm px-2 py-1 rounded ${
                        withdrawal.status === 'settled' ? 'bg-green-600 text-white' :
                        'bg-yellow-100 text-yellow-800'
                      }`}>
                        {withdrawal.status === 'settled' ? '✅ Settled' : '⏳ Pending'}
                      </span>
                    </div>
                    <div className="text-sm text-gray-600 space-y-1 mt-2">
                      <p>Shares: {formatShares(withdrawal.shares)}</p>
                      <p>{new Date(withdrawal.timestamp).toLocaleString()}</p>
                      {withdrawal.txHash && (
                        <p className="text-xs">
                          <a 
                            href={`https://snowtrace.io/tx/${withdrawal.txHash}`}
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
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-2 border-black p-6">
            <h2 className="text-2xl font-bold mb-4">Daily Snapshots</h2>
            <p className="text-sm text-gray-500 mb-4">
              Snapshots capture daily vault state (AUM, deposits, withdrawals) for attribution tracking.
            </p>
            {loading ? (
              <p className="text-gray-700">Loading...</p>
            ) : snapshots.length === 0 ? (
              <p className="text-gray-500 italic">No snapshots yet. Snapshots are generated daily by the indexer.</p>
            ) : (
              <div className="space-y-4">
                {snapshots.slice(0, 7).map((snapshot, idx) => (
                  <div key={idx} className="border border-gray-300 p-4">
                    <div className="flex justify-between items-start mb-2">
                      <span className="font-semibold">{snapshot.date}</span>
                      <span className="text-sm">{snapshot.aum} USDC</span>
                    </div>
                    <div className="text-sm text-gray-600 space-y-1">
                      <p>Deposits: {snapshot.totalDeposits} USDC</p>
                      <p>Withdrawals: {snapshot.totalWithdrawals} USDC</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}


