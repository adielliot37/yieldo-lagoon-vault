'use client'

import { VAULTS_CONFIG, VaultConfig } from '@/lib/vaults-config'
import { useAccount, useSwitchChain } from 'wagmi'

interface VaultSelectorProps {
  selectedVaultId: string | null
  onVaultChange: (vaultId: string) => void
  showCombined?: boolean
}

export function VaultSelector({ selectedVaultId, onVaultChange, showCombined = true }: VaultSelectorProps) {
  const { chain } = useAccount()
  const { switchChain } = useSwitchChain()

  const handleVaultSelect = async (vault: VaultConfig) => {
    if (chain?.id !== vault.chainId) {
      try {
        await switchChain({ chainId: vault.chainId })
      } catch (error) {
        console.error('Failed to switch chain:', error)
      }
    }
    onVaultChange(vault.id)
  }

  return (
    <div className="mb-6">
      <label className="block text-sm font-semibold mb-2">Select Vault</label>
      <div className="flex flex-wrap gap-2">
        {showCombined && (
          <button
            onClick={() => onVaultChange('combined')}
            className={`px-4 py-2 border-2 rounded transition-colors ${
              selectedVaultId === 'combined'
                ? 'border-black bg-black text-white'
                : 'border-gray-300 hover:border-black'
            }`}
          >
            All Vaults (Combined)
          </button>
        )}
        {VAULTS_CONFIG.map((vault) => (
          <button
            key={vault.id}
            onClick={() => handleVaultSelect(vault)}
            className={`px-4 py-2 border-2 rounded transition-colors ${
              selectedVaultId === vault.id
                ? 'border-black bg-black text-white'
                : 'border-gray-300 hover:border-black'
            }`}
          >
            {vault.name}
            <span className="ml-2 text-xs opacity-75">({vault.chain})</span>
          </button>
        ))}
      </div>
      {selectedVaultId && selectedVaultId !== 'combined' && (
        <p className="text-xs text-gray-500 mt-2">
          {chain?.id !== VAULTS_CONFIG.find(v => v.id === selectedVaultId)?.chainId && (
            <span className="text-yellow-600">⚠️ Switch to {VAULTS_CONFIG.find(v => v.id === selectedVaultId)?.chain} to interact</span>
          )}
        </p>
      )}
    </div>
  )
}


