'use client'

import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { getVaultById } from '@/lib/vaults-config'
import { getIndexerApiUrl, getRatingColor } from '@/lib/vault-ratings'
import type { VaultRating, VaultRatingMetrics } from '@/lib/vault-ratings'

function formatUsd(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return '—'
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}K`
  return `$${value.toFixed(2)}`
}

function formatPct(value: number | null | undefined, decimals = 2): string {
  if (value == null || isNaN(value)) return '—'
  return `${(value * 100).toFixed(decimals)}%`
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-b border-gray-100 last:border-0">
      <td className="py-2 pr-4 text-gray-600">{label}</td>
      <td className="py-2 text-right font-mono text-sm text-gray-900">{value}</td>
    </tr>
  )
}

export default function VaultScoringPage() {
  const params = useParams()
  const vaultId = typeof params.vault_id === 'string' ? params.vault_id : ''
  const vaultConfig = getVaultById(vaultId)

  const [rating, setRating] = useState<VaultRating | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!vaultId) {
      setLoading(false)
      setError('Missing vault')
      return
    }
    const apiUrl = getIndexerApiUrl()
    const chain = vaultConfig?.chain
    const url = chain
      ? `${apiUrl}/api/vault-ratings?vault_id=${encodeURIComponent(vaultId)}&chain=${encodeURIComponent(chain)}`
      : `${apiUrl}/api/vault-ratings?vault_id=${encodeURIComponent(vaultId)}`
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load rating')
        return res.json()
      })
      .then((data) => {
        const list = Array.isArray(data) ? data : []
        const doc = list.find((r: VaultRating) => r.vault_id === vaultId && (!chain || r.chain === chain)) ?? list[0] ?? null
        setRating(doc)
        setError(doc ? null : 'No rating data yet')
      })
      .catch((e) => {
        setError(e.message || 'Failed to load')
        setRating(null)
      })
      .finally(() => setLoading(false))
  }, [vaultId, vaultConfig?.chain])

  if (!vaultConfig) {
    return (
      <main className="min-h-screen bg-gray-50">
        <nav className="border-b border-gray-200 bg-white px-6 py-4">
          <div className="max-w-5xl mx-auto flex items-center gap-4">
            <Link href="/" className="text-gray-600 hover:text-black">← Yieldo</Link>
          </div>
        </nav>
        <div className="max-w-5xl mx-auto px-6 py-12 text-center text-gray-600">
          Vault not found.
        </div>
      </main>
    )
  }

  const score = rating?.score ?? null
  const { label, style: ratingStyle } = getRatingColor(score)
  const metrics: VaultRatingMetrics = rating?.metrics ?? {}
  const breakdown = rating?.score_breakdown ?? {}

  return (
    <main className="min-h-screen bg-gray-50">
      <nav className="border-b border-gray-200 bg-white px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="text-gray-600 hover:text-black">← Yieldo</Link>
          <Link href="/dashboard" className="text-sm text-gray-600 hover:text-black">Dashboard</Link>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-6 py-8">
        <header className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">{metrics.lagoonName ?? vaultConfig.name}</h1>
          <p className="text-sm text-gray-500 capitalize mt-1">{vaultConfig.chain} · {metrics.underlyingSymbol ?? vaultConfig.asset.symbol} vault</p>
          {metrics.lagoonDescription && (
            <p className="text-sm text-gray-600 mt-2">{metrics.lagoonDescription}</p>
          )}
        </header>

        {loading && (
          <p className="text-gray-500">Loading scoring data…</p>
        )}

        {error && !loading && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-800">
            {error}. Run the vault KPI job to populate ratings.
          </div>
        )}

        {rating && !loading && (
          <div className="space-y-8">
            {/* Composite score hero */}
            <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-4">Composite Score</h2>
              <div className="flex flex-wrap items-center gap-6">
                <div
                  className="rounded-xl px-6 py-4"
                  style={{ backgroundColor: ratingStyle.backgroundColor, color: ratingStyle.color }}
                >
                  <span className="text-4xl font-bold">{score != null ? Math.round(score) : '—'}</span>
                  <span className="ml-2 text-lg opacity-90">/ 100</span>
                </div>
                <div>
                  <p className="font-medium text-gray-900">{label}</p>
                  <p className="text-sm text-gray-500">Updated {rating.updated_at ? new Date(rating.updated_at).toLocaleString() : '—'}</p>
                </div>
              </div>
            </section>

            {/* Score breakdown (Capital, Performance, Risk, Trust) */}
            <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-4">Score Breakdown</h2>
              <div className={`grid grid-cols-1 gap-4 ${breakdown.userTrust != null ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
                <div className="rounded-lg bg-gray-50 p-4">
                  <p className="text-xs font-medium text-gray-500 uppercase">Capital ({breakdown.userTrust != null ? '20%' : '25%'})</p>
                  <p className="text-2xl font-bold text-gray-900">{breakdown.capital != null ? Math.round(breakdown.capital) : '—'}</p>
                  <p className="text-xs text-gray-400 mt-1">TVL size</p>
                </div>
                <div className="rounded-lg bg-gray-50 p-4">
                  <p className="text-xs font-medium text-gray-500 uppercase">Performance ({breakdown.userTrust != null ? '30%' : '35%'})</p>
                  <p className="text-2xl font-bold text-gray-900">{breakdown.performance != null ? Math.round(breakdown.performance) : '—'}</p>
                  <p className="text-xs text-gray-400 mt-1">APR (7d, 30d, all-time)</p>
                </div>
                <div className="rounded-lg bg-gray-50 p-4">
                  <p className="text-xs font-medium text-gray-500 uppercase">Risk ({breakdown.userTrust != null ? '30%' : '40%'})</p>
                  <p className="text-2xl font-bold text-gray-900">{breakdown.risk != null ? Math.round(breakdown.risk) : '—'}</p>
                  <p className="text-xs text-gray-400 mt-1">Pause, depeg, fees</p>
                </div>
                {breakdown.userTrust != null && (
                  <div className="rounded-lg bg-blue-50 p-4">
                    <p className="text-xs font-medium text-blue-600 uppercase">User Trust (20%)</p>
                    <p className="text-2xl font-bold text-blue-700">{Math.round(breakdown.userTrust)}</p>
                    <p className="text-xs text-blue-400 mt-1">Retention, holding time</p>
                  </div>
                )}
              </div>
              
              {/* Scoring guide */}
              <div className="mt-4 pt-4 border-t border-gray-100">
                <p className="text-xs text-gray-500">
                  <span className="font-medium">Score Guide:</span>{' '}
                  <span className="inline-block px-1.5 py-0.5 rounded text-white" style={{ backgroundColor: '#10b981' }}>80-100 Excellent</span>{' '}
                  <span className="inline-block px-1.5 py-0.5 rounded text-white" style={{ backgroundColor: '#22c55e' }}>60-79 Good</span>{' '}
                  <span className="inline-block px-1.5 py-0.5 rounded text-black" style={{ backgroundColor: '#f59e0b' }}>40-59 Moderate</span>{' '}
                  <span className="inline-block px-1.5 py-0.5 rounded text-white" style={{ backgroundColor: '#ef4444' }}>0-39 Poor</span>
                </p>
              </div>
            </section>

            {/* Capital metrics from Lagoon */}
            <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-4">Capital Metrics</h2>
              <p className="text-xs text-gray-400 mb-3">Data from Lagoon Finance</p>
              <table className="w-full">
                <tbody>
                  <MetricRow label="TVL (USD)" value={formatUsd(metrics.tvlUsd)} />
                  <MetricRow label="Total supply (shares)" value={metrics.totalSupply ? `${(Number(metrics.totalSupply) / 1e18).toFixed(2)}` : '—'} />
                </tbody>
              </table>
            </section>

            {/* Performance metrics - APR from Lagoon */}
            <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-4">Performance Metrics</h2>
              <p className="text-xs text-gray-400 mb-3">APR data from Lagoon Finance (official source)</p>
              <table className="w-full">
                <tbody>
                  <MetricRow label="Net APR (7d)" value={formatPct(metrics.apr7d)} />
                  <MetricRow label="Net APR (30d)" value={formatPct(metrics.apr30d)} />
                  <MetricRow label="Net APR (All-time)" value={formatPct(metrics.aprAll)} />
                  <MetricRow label="Base APR (no airdrops)" value={formatPct(metrics.aprBase)} />
                  <MetricRow label="Share price (USD)" value={metrics.pricePerShareUsd != null ? `$${metrics.pricePerShareUsd.toFixed(6)}` : '—'} />
                  <MetricRow label="High water mark" value={metrics.highWaterMark != null ? `${metrics.highWaterMark}` : '—'} />
                </tbody>
              </table>
            </section>

            {/* Risk flags */}
            <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-4">Risk Flags</h2>
              <table className="w-full">
                <tbody>
                  <MetricRow label="Vault state" value={metrics.vaultState ?? '—'} />
                  <MetricRow label="Vault paused" value={metrics.vaultPaused ? 'Yes' : 'No'} />
                  <MetricRow label="Asset depeg" value={metrics.assetDepeg === true ? 'Yes' : metrics.assetDepeg === false ? 'No' : '—'} />
                  <MetricRow label="Whitelist activated" value={metrics.isWhitelistActivated ? 'Yes' : 'No'} />
                </tbody>
              </table>
            </section>

            {/* Fees */}
            <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-4">Vault Fees</h2>
              <table className="w-full">
                <tbody>
                  <MetricRow label="Management fee" value={metrics.managementFee != null ? `${(metrics.managementFee / 100).toFixed(2)}%` : '—'} />
                  <MetricRow label="Performance fee" value={metrics.performanceFee != null ? `${(metrics.performanceFee / 100).toFixed(2)}%` : '—'} />
                </tbody>
              </table>
            </section>

            {/* Underlying asset */}
            <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-4">Underlying Asset</h2>
              <table className="w-full">
                <tbody>
                  <MetricRow label="Symbol" value={metrics.underlyingSymbol ?? '—'} />
                  <MetricRow label="Price (USD)" value={metrics.underlyingPrice != null ? `$${metrics.underlyingPrice.toFixed(4)}` : '—'} />
                  <MetricRow label="Decimals" value={metrics.underlyingDecimals != null ? String(metrics.underlyingDecimals) : '—'} />
                </tbody>
              </table>
            </section>

            {/* Vault info */}
            <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-4">Vault Info</h2>
              <table className="w-full">
                <tbody>
                  <MetricRow label="Symbol" value={metrics.lagoonSymbol ?? '—'} />
                  {metrics.lagoonCurators && metrics.lagoonCurators.length > 0 && (
                    <MetricRow label="Curators" value={metrics.lagoonCurators.join(', ')} />
                  )}
                  <MetricRow label="Vault version" value={metrics.lagoonVersion ?? '—'} />
                  <MetricRow label="Has airdrops" value={metrics.hasAirdrops ? 'Yes' : 'No'} />
                  <MetricRow label="Has incentives" value={metrics.hasIncentives ? 'Yes' : 'No'} />
                </tbody>
              </table>
            </section>

            {/* User Behavior Analytics */}
            {metrics.userAnalytics && (
              <>
                <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">User Behavior Analytics</h2>
                    <span 
                      className="px-2 py-1 rounded text-sm font-bold"
                      style={{ 
                        backgroundColor: metrics.userAnalytics.trustScore >= 70 ? '#10b981' : metrics.userAnalytics.trustScore >= 50 ? '#f59e0b' : '#ef4444',
                        color: '#fff'
                      }}
                    >
                      Trust Score: {metrics.userAnalytics.trustScore}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 mb-3">Based on on-chain deposit/withdraw events</p>
                  
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                    <div className="bg-gray-50 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-gray-900">{metrics.userAnalytics.totalUsers}</p>
                      <p className="text-xs text-gray-500">Total Users</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-green-600">{metrics.userAnalytics.activeHolders}</p>
                      <p className="text-xs text-gray-500">Active Holders</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-gray-900">{metrics.userAnalytics.retentionRate}%</p>
                      <p className="text-xs text-gray-500">Retention Rate</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-gray-900">{metrics.userAnalytics.avgHoldingDays}d</p>
                      <p className="text-xs text-gray-500">Avg Holding</p>
                    </div>
                  </div>

                  <table className="w-full">
                    <tbody>
                      <MetricRow label="Median holding days" value={`${metrics.userAnalytics.medianHoldingDays} days`} />
                      <MetricRow label="Holders > 30 days" value={String(metrics.userAnalytics.holdersOver30Days)} />
                      <MetricRow label="Holders > 90 days" value={String(metrics.userAnalytics.holdersOver90Days)} />
                      <MetricRow label="Holders > 180 days" value={String(metrics.userAnalytics.holdersOver180Days)} />
                      <MetricRow label="Users with multiple deposits" value={String(metrics.userAnalytics.usersWithMultipleDeposits)} />
                      <MetricRow label="Avg deposits per user" value={String(metrics.userAnalytics.avgDepositsPerUser)} />
                      {metrics.userAnalytics.totalDepositedUsd != null && (
                        <MetricRow label="Total deposited (all-time)" value={`$${Math.round(metrics.userAnalytics.totalDepositedUsd).toLocaleString()}`} />
                      )}
                      {metrics.userAnalytics.totalWithdrawnUsd != null && (
                        <MetricRow label="Total withdrawn (all-time)" value={`$${Math.round(metrics.userAnalytics.totalWithdrawnUsd).toLocaleString()}`} />
                      )}
                      {metrics.userAnalytics.transactionCount != null && (
                        <MetricRow label="Total transactions" value={String(metrics.userAnalytics.transactionCount)} />
                      )}
                    </tbody>
                  </table>
                </section>

                {/* Farming Detection */}
                <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-4">Farming Detection</h2>
                  <p className="text-xs text-gray-400 mb-3">Users who deposited and withdrew within 7 days (likely farming points)</p>
                  
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
                    <div className="bg-gray-50 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-red-500">{metrics.userAnalytics.exitedUsers}</p>
                      <p className="text-xs text-gray-500">Exited Users</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-amber-500">{metrics.userAnalytics.quickExiters}</p>
                      <p className="text-xs text-gray-500">Quick Exiters (&lt;7d)</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-gray-900">{metrics.userAnalytics.quickExitRate}%</p>
                      <p className="text-xs text-gray-500">Quick Exit Rate</p>
                    </div>
                  </div>

                  {metrics.userAnalytics.likelyFarmers && metrics.userAnalytics.likelyFarmers.length > 0 && (
                    <div className="mt-4">
                      <p className="text-xs font-medium text-gray-500 mb-2">Likely Farmers (quick in/out)</p>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-gray-200">
                              <th className="text-left py-1 text-gray-500">Address</th>
                              <th className="text-right py-1 text-gray-500">Days Held</th>
                              <th className="text-right py-1 text-gray-500">Volume</th>
                            </tr>
                          </thead>
                          <tbody>
                            {metrics.userAnalytics.likelyFarmers.slice(0, 5).map((u, i) => (
                              <tr key={i} className="border-b border-gray-100">
                                <td className="py-1 font-mono text-gray-600">{u.address.slice(0, 6)}...{u.address.slice(-4)}</td>
                                <td className="py-1 text-right text-amber-600">{u.daysHeld}d</td>
                                <td className="py-1 text-right">{u.volumeUsd ? `$${u.volumeUsd.toLocaleString()}` : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </section>

                {/* Long-term Holders */}
                {metrics.userAnalytics.longTermHolders && metrics.userAnalytics.longTermHolders.length > 0 && (
                  <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-4">Long-term Holders</h2>
                    <p className="text-xs text-gray-400 mb-3">Users holding for more than 90 days (high trust)</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-gray-200">
                            <th className="text-left py-1 text-gray-500">Address</th>
                            <th className="text-right py-1 text-gray-500">Days</th>
                            <th className="text-right py-1 text-gray-500">Deposited</th>
                          </tr>
                        </thead>
                        <tbody>
                          {metrics.userAnalytics.longTermHolders.slice(0, 10).map((u, i) => (
                            <tr key={i} className="border-b border-gray-100">
                              <td className="py-1 font-mono text-gray-600">{u.address.slice(0, 6)}...{u.address.slice(-4)}</td>
                              <td className="py-1 text-right text-green-600 font-medium">{u.holdingDays}</td>
                              <td className="py-1 text-right">{u.totalDepositedUsd ? `$${u.totalDepositedUsd.toLocaleString()}` : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}

                {/* Smart Depositors */}
                {metrics.userAnalytics.smartDepositors && metrics.userAnalytics.smartDepositors.length > 0 && (
                  <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-4">Smart Depositors</h2>
                    <p className="text-xs text-gray-400 mb-3">Users with multiple deposits and long holding periods (&gt;60 days)</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-gray-200">
                            <th className="text-left py-1 text-gray-500">Address</th>
                            <th className="text-right py-1 text-gray-500">Days</th>
                            <th className="text-right py-1 text-gray-500">Total Deposited</th>
                          </tr>
                        </thead>
                        <tbody>
                          {metrics.userAnalytics.smartDepositors.slice(0, 10).map((u, i) => (
                            <tr key={i} className="border-b border-gray-100">
                              <td className="py-1 font-mono text-gray-600">{u.address.slice(0, 6)}...{u.address.slice(-4)}</td>
                              <td className="py-1 text-right text-green-600 font-medium">{u.holdingDays}</td>
                              <td className="py-1 text-right">{u.totalDepositedUsd ? `$${u.totalDepositedUsd.toLocaleString()}` : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
              </>
            )}

            {/* Data source note */}
            <p className="text-xs text-gray-400 text-center">
              All data from Lagoon Finance API · Updated {rating.updated_at ? new Date(rating.updated_at).toLocaleString() : '—'}
            </p>
          </div>
        )}
      </div>
    </main>
  )
}
