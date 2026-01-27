'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { RainbowKitProvider, getDefaultConfig } from '@rainbow-me/rainbowkit'
import { avalanche, mainnet } from 'wagmi/chains'
import '@rainbow-me/rainbowkit/styles.css'
import { useState, useMemo } from 'react'

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '0dd252f3816efa3917348bf2b60af0aa'

let wagmiConfigInstance: ReturnType<typeof getDefaultConfig> | null = null

function getWagmiConfig() {
  if (!wagmiConfigInstance) {
    wagmiConfigInstance = getDefaultConfig({
      appName: 'Yieldo',
      projectId,
      chains: [avalanche, mainnet], // Support both Avalanche and Ethereum
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

