'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider, createConfig, http } from 'wagmi'
import { RainbowKitProvider, getDefaultWallets, connectorsForWallets } from '@rainbow-me/rainbowkit'
import { avalanche, mainnet } from 'wagmi/chains'
import '@rainbow-me/rainbowkit/styles.css'
import { useState } from 'react'

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '0dd252f3816efa3917348bf2b60af0aa'

// Custom RPC URLs - explicitly set to avoid eth.merkle.io
const avalancheRpcUrl = process.env.NEXT_PUBLIC_AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc'
const ethereumRpcUrl = process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL || 'https://1rpc.io/eth'

// Configure chains with explicit RPC URLs (no eth.merkle.io)
const chains = [avalanche, mainnet] as const

const { wallets } = getDefaultWallets({
  appName: 'Yieldo',
  projectId,
})

const connectors = connectorsForWallets(wallets, {
  appName: 'Yieldo',
  projectId,
})

let wagmiConfigInstance: ReturnType<typeof createConfig> | null = null

function getWagmiConfig() {
  if (!wagmiConfigInstance) {
    wagmiConfigInstance = createConfig({
      chains,
      connectors,
      transports: {
        [avalanche.id]: http(avalancheRpcUrl),
        [mainnet.id]: http(ethereumRpcUrl),
      },
      ssr: true,
    })
  }
  return wagmiConfigInstance
}

export const wagmiConfig = getWagmiConfig()

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  }))

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

