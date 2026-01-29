'use client'

import Link from 'next/link'
import { useState, useRef, useEffect } from 'react'
import type { VaultRating } from '@/lib/vault-ratings'
import { getRatingColor } from '@/lib/vault-ratings'

interface VaultRatingBubbleProps {
  rating: VaultRating | null
  vaultId: string
  vaultName: string
  chain: string
}

function formatUsd(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return '—'
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}K`
  return `$${value.toFixed(2)}`
}

export function VaultRatingBubble({ rating, vaultId, vaultName, chain }: VaultRatingBubbleProps) {
  const [showTooltip, setShowTooltip] = useState(false)
  const tooltipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showTooltip) return
    const handleClickOutside = (e: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node)) {
        setShowTooltip(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showTooltip])

  const score = rating?.score ?? null
  const { label, style: ratingStyle } = getRatingColor(score)
  const breakdown = rating?.score_breakdown
  const metrics = rating?.metrics
  const tvlUsd = metrics?.tvlUsd
  const apr30d = metrics?.apr30d
  const apr7d = metrics?.apr7d
  const aprAll = metrics?.aprAll
  const userAnalytics = metrics?.userAnalytics

  return (
    <div className="relative inline-flex items-end justify-end" ref={tooltipRef}>
      <Link
        href={`/vault-scoring/${vaultId}`}
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-bold shadow-md ring-1 ring-black/10 hover:brightness-95"
        style={{ backgroundColor: ratingStyle.backgroundColor, color: ratingStyle.color }}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        title="View full scoring"
      >
        <span aria-hidden className="opacity-90">Score</span>
        <span>{score != null ? Math.round(score) : '—'}</span>
      </Link>

      {showTooltip && (
        <div
          className="absolute right-0 bottom-full z-[100] mb-2 w-72 rounded-lg border border-gray-200 bg-white p-3 shadow-xl"
          style={{ minWidth: '16rem' }}
          onMouseEnter={() => setShowTooltip(true)}
          onMouseLeave={() => setShowTooltip(false)}
        >
          <p className="font-semibold text-gray-900">{vaultName}</p>
          <p className="text-xs text-gray-500 capitalize">{chain}</p>
          <div className="mt-2 flex items-center justify-between border-b border-gray-100 pb-2">
            <span className="text-xs text-gray-500">Composite</span>
            <span className="rounded px-1.5 py-0.5 text-sm font-bold" style={{ backgroundColor: ratingStyle.backgroundColor, color: ratingStyle.color }}>
              {score != null ? Math.round(score) : '—'} {label !== '—' && `(${label})`}
            </span>
          </div>
          <div className="mt-2 space-y-1 text-xs text-gray-600">
            <div className="flex justify-between">
              <span>Capital</span>
              <span>{breakdown?.capital != null ? Math.round(breakdown.capital) : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span>Performance</span>
              <span>{breakdown?.performance != null ? Math.round(breakdown.performance) : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span>Risk</span>
              <span>{breakdown?.risk != null ? Math.round(breakdown.risk) : '—'}</span>
            </div>
            {breakdown?.userTrust != null && (
              <div className="flex justify-between text-blue-600">
                <span>User Trust</span>
                <span>{Math.round(breakdown.userTrust)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-gray-100 pt-1">
              <span>TVL</span>
              <span>{formatUsd(tvlUsd)}</span>
            </div>
            {apr7d != null && (
              <div className="flex justify-between">
                <span>APR (7d)</span>
                <span className="text-green-600">{(apr7d * 100).toFixed(2)}%</span>
              </div>
            )}
            {apr30d != null && (
              <div className="flex justify-between">
                <span>APR (30d)</span>
                <span className="text-green-600">{(apr30d * 100).toFixed(2)}%</span>
              </div>
            )}
            {aprAll != null && (
              <div className="flex justify-between">
                <span>APR (All)</span>
                <span className="text-green-600">{(aprAll * 100).toFixed(2)}%</span>
              </div>
            )}
            {userAnalytics && (
              <>
                <div className="flex justify-between border-t border-gray-100 pt-1 mt-1">
                  <span>Users</span>
                  <span>{userAnalytics.totalUsers} ({userAnalytics.activeHolders} active)</span>
                </div>
                <div className="flex justify-between">
                  <span>Retention</span>
                  <span className={userAnalytics.retentionRate >= 70 ? 'text-green-600' : userAnalytics.retentionRate >= 50 ? 'text-amber-600' : 'text-red-600'}>
                    {userAnalytics.retentionRate}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Avg Holding</span>
                  <span>{userAnalytics.avgHoldingDays} days</span>
                </div>
              </>
            )}
          </div>
          <Link
            href={`/vault-scoring/${vaultId}`}
            className="mt-3 block w-full rounded bg-gray-900 py-1.5 text-center text-xs font-medium text-white hover:bg-gray-800"
          >
            View full scoring →
          </Link>
        </div>
      )}
    </div>
  )
}
