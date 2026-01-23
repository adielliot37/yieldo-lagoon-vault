'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import Link from 'next/link'

export default function Home() {
  return (
    <main className="min-h-screen bg-white text-black">
      <nav className="border-b border-black px-6 py-4">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <h1 className="text-2xl font-bold">Yieldo</h1>
          <ConnectButton />
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="text-center mb-16">
          <h2 className="text-5xl font-bold mb-4">Lagoon Vault Integration</h2>
          <p className="text-xl text-gray-700">E2E Deposit Attribution + Deterministic Snapshot Pipeline</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
          <Link href="/dashboard" className="border-2 border-black p-8 hover:bg-black hover:text-white transition-colors">
            <h3 className="text-2xl font-bold mb-4">Dashboard</h3>
            <p className="text-gray-700">Track your deposits, withdrawals, and vault performance</p>
          </Link>

          <Link href="/kol" className="border-2 border-black p-8 hover:bg-black hover:text-white transition-colors">
            <h3 className="text-2xl font-bold mb-4">KOL Landing</h3>
            <p className="text-gray-700">Simple interface for initiating transactions</p>
          </Link>
        </div>

        <div className="border-t border-black pt-8">
          <h3 className="text-xl font-bold mb-4">Features</h3>
          <ul className="space-y-2 text-gray-700">
            <li>• EIP-712 intent verification for deposits</li>
            <li>• Async vault support (Lagoon on Avalanche)</li>
            <li>• Real-time event indexing</li>
            <li>• Daily deterministic snapshots</li>
            <li>• USDC deposits only</li>
          </ul>
        </div>

        <div className="border-t border-black pt-8 mt-8">
          <h3 className="text-xl font-bold mb-4">Integrated Vault</h3>
          <div className="bg-gray-50 border border-black p-4">
            <p className="font-semibold text-lg mb-2">Turtle Avalanche USDC</p>
            <p className="text-sm text-gray-600 mb-2">Lagoon Vault on Avalanche</p>
            <p className="text-xs text-gray-500 break-all">
              Address: 0x3048925b3ea5a8c12eecccb8810f5f7544db54af
            </p>
            <a 
              href="https://snowtrace.io/address/0x3048925b3ea5a8c12eecccb8810f5f7544db54af"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:underline mt-2 inline-block"
            >
              View on Snowtrace →
            </a>
          </div>
        </div>
      </div>
    </main>
  )
}

