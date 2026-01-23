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
}

interface Snapshot {
  date: string
  aum: string
  totalDeposits: string
  totalWithdrawals: string
}

// Helper to format USDC amount (6 decimals)
const formatUSDC = (amount: string | number): string => {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  // If amount looks like raw wei (> 1000), divide by 10^6
  if (num > 1000) {
    return (num / 1e6).toFixed(2)
  }
  return num.toFixed(2)
}

export default function Dashboard() {
  const { address, isConnected } = useAccount()
  const [deposits, setDeposits] = useState<DepositIntent[]>([])
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (isConnected && address) {
      fetchUserData()
    }
  }, [isConnected, address])

  const fetchUserData = async () => {
    try {
      const apiUrl = process.env.NEXT_PUBLIC_INDEXER_API_URL || 'http://localhost:3001'
      const [depositsRes, snapshotsRes] = await Promise.all([
        fetch(`${apiUrl}/api/deposits?user=${address}`),
        fetch(`${apiUrl}/api/snapshots`)
      ])
      
      if (depositsRes.ok) {
        const depositsData = await depositsRes.json()
        setDeposits(depositsData)
      }
      
      if (snapshotsRes.ok) {
        const snapshotsData = await snapshotsRes.json()
        setSnapshots(snapshotsData)
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
                      <span className="font-semibold">{formatUSDC(deposit.amount)} USDC</span>
                      <span className={`text-sm px-2 py-1 rounded ${
                        deposit.status === 'settled' || deposit.status === 'executed' ? 'bg-green-600 text-white' :
                        deposit.status === 'confirmed' ? 'bg-blue-500 text-white' :
                        'bg-yellow-100 text-yellow-800'
                      }`}>
                        {deposit.status === 'executed' ? '✅ Executed' : deposit.status}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600">
                      {new Date(deposit.timestamp).toLocaleString()}
                    </p>
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


