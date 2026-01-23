'use client'

import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useChainId, usePublicClient } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { parseUnits, formatUnits, Address } from 'viem'
import { getVaultState } from '@/lib/lagoon'
import { signDepositIntent, getIntentHash, type DepositIntent } from '@/lib/eip712'
import ERC20_ABI from '@/lib/erc20-abi.json'
import DEPOSIT_ROUTER_ABI from '@/lib/deposit-router-abi.json'

const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS || '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'
const VAULT_ADDRESS = process.env.NEXT_PUBLIC_LAGOON_VAULT_ADDRESS || '0x3048925b3ea5a8c12eecccb8810f5f7544db54af'
const DEPOSIT_ROUTER_ADDRESS = process.env.NEXT_PUBLIC_DEPOSIT_ROUTER_ADDRESS

if (typeof window !== 'undefined' && !DEPOSIT_ROUTER_ADDRESS) {
  console.error('⚠️ NEXT_PUBLIC_DEPOSIT_ROUTER_ADDRESS is not set in .env file!')
} 

export default function KOLPage() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const [amount, setAmount] = useState('')
  const [vaultState, setVaultState] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState<bigint>(BigInt(0))
  const [approvalHash, setApprovalHash] = useState<`0x${string}` | undefined>()
  const [isApproving, setIsApproving] = useState(false)
  const [currentTxType, setCurrentTxType] = useState<'approve' | 'deposit' | 'execute' | null>(null)
  const [pendingIntentHash, setPendingIntentHash] = useState<`0x${string}` | null>(null)
  const [pendingIntents, setPendingIntents] = useState<any[]>([])
  const [loadingIntents, setLoadingIntents] = useState(false)
  const [executeSuccess, setExecuteSuccess] = useState(false)
  const [executedHash, setExecutedHash] = useState<`0x${string}` | null>(null)
  const [depositSuccess, setDepositSuccess] = useState(false)
  const [depositHash, setDepositHash] = useState<`0x${string}` | null>(null)
  const publicClient = usePublicClient()

  const { writeContract, data: hash, isPending, reset: resetWriteContract, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess, isError: isReceiptError, error: receiptError } = useWaitForTransactionReceipt({
    hash,
  })

  const { 
    isLoading: isApprovalConfirming, 
    isSuccess: isApprovalSuccess 
  } = useWaitForTransactionReceipt({
    hash: approvalHash,
  })

  useEffect(() => {
    if (hash && currentTxType === 'approve' && !approvalHash) {
      setApprovalHash(hash)
    }
  }, [hash, currentTxType, approvalHash])

  const fetchPendingIntents = async () => {
    if (!address) return
    
    try {
      setLoadingIntents(true)
      const response = await fetch(`${process.env.NEXT_PUBLIC_INDEXER_API_URL || 'http://localhost:3001'}/api/intents?user=${address}`)
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
      const data = await response.json()
      const pending = data.filter((intent: any) => intent.status === 'pending')
      setPendingIntents(pending)
    } catch (error) {
      console.error('Error fetching pending intents:', error)
      setPendingIntents([])
    } finally {
      setLoadingIntents(false)
    }
  }

  useEffect(() => {
    if (address) {
      fetchPendingIntents()
      const interval = setInterval(fetchPendingIntents, 30000)
      return () => clearInterval(interval)
    }
  }, [address])

  useEffect(() => {
    if (isSuccess && currentTxType === 'deposit' && hash) {
      setDepositSuccess(true)
      setDepositHash(hash)
      setLoading(false)
      setCurrentTxType(null)
      
      setTimeout(() => {
        fetchPendingIntents()
      }, 2000)
      
      setTimeout(() => {
        setDepositSuccess(false)
        setDepositHash(null)
      }, 10000)
    }
  }, [isSuccess, currentTxType, hash, fetchPendingIntents])
  const { data: userNonce } = useReadContract({
    address: DEPOSIT_ROUTER_ADDRESS as Address,
    abi: DEPOSIT_ROUTER_ABI,
    functionName: 'nonces',
    args: address ? [address] : undefined,
    query: { 
      enabled: !!address && !!DEPOSIT_ROUTER_ADDRESS,
      staleTime: 30 * 1000,
      refetchOnWindowFocus: false,
    },
  })

  useEffect(() => {
    if (userNonce !== undefined) {
      setNonce(userNonce as bigint)
    }
  }, [userNonce])

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS as Address,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address && DEPOSIT_ROUTER_ADDRESS ? [address, DEPOSIT_ROUTER_ADDRESS as Address] : undefined,
    query: { 
      enabled: !!address && !!DEPOSIT_ROUTER_ADDRESS,
      staleTime: 10 * 1000,
      refetchInterval: false,
      refetchOnWindowFocus: false,
    },
  })

  useEffect(() => {
    if (isApprovalSuccess) {
      setIsApproving(false)
      setCurrentTxType(null)
      resetWriteContract()
      const timers = [
        setTimeout(() => refetchAllowance(), 1000),
        setTimeout(() => refetchAllowance(), 3000),
        setTimeout(() => refetchAllowance(), 5000),
      ]
      return () => timers.forEach(timer => clearTimeout(timer))
    }
  }, [isApprovalSuccess, refetchAllowance, resetWriteContract])

  useEffect(() => {
    if (isApprovalConfirming) {
      const interval = setInterval(() => {
        refetchAllowance()
      }, 2000)
      return () => clearInterval(interval)
    }
  }, [isApprovalConfirming, refetchAllowance])
  useEffect(() => {
    if (VAULT_ADDRESS && isConnected) {
      fetchVaultState()
    }
  }, [VAULT_ADDRESS, isConnected])

  const fetchVaultState = async () => {
    if (!VAULT_ADDRESS) {
      alert('Vault address not configured')
      return
    }
    
    try {
      setLoading(true)
      const state = await getVaultState(VAULT_ADDRESS as Address)
      setVaultState(state)
    } catch (error) {
      console.error('Failed to fetch vault state:', error)
      alert('Failed to fetch vault state: ' + (error as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleApprove = async () => {
    if (!isConnected || !amount) {
      alert('Please connect wallet and enter amount')
      return
    }

    try {
      setIsApproving(true)
      setCurrentTxType('approve')
      const depositAmount = parseUnits(amount, 6)
      
      writeContract({
        address: USDC_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [DEPOSIT_ROUTER_ADDRESS as Address, depositAmount],
      })
    } catch (error) {
      console.error('Approve failed:', error)
      alert('Approve failed: ' + (error as Error).message)
      setIsApproving(false)
      setCurrentTxType(null)
    }
  }

  const handleDeposit = async () => {
    if (!isConnected || !amount || !VAULT_ADDRESS || !address) {
      alert('Please connect wallet and enter amount')
      return
    }

    try {
      setLoading(true)
      setCurrentTxType('deposit')
      setDepositSuccess(false)
      setDepositHash(null)
      resetWriteContract()
      
      const depositAmount = parseUnits(amount, 6)
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

      const intent: DepositIntent = {
        user: address,
        vault: VAULT_ADDRESS as Address,
        asset: USDC_ADDRESS as Address,
        amount: depositAmount,
        nonce: nonce,
        deadline: deadline,
      }

      if (!DEPOSIT_ROUTER_ADDRESS || DEPOSIT_ROUTER_ADDRESS === '0x0000000000000000000000000000000000000000') {
        alert('Contract address not configured. Please set NEXT_PUBLIC_DEPOSIT_ROUTER_ADDRESS in .env file and restart the frontend.')
        setLoading(false)
        setCurrentTxType(null)
        return
      }

      const signature = await signDepositIntent(intent, chainId, DEPOSIT_ROUTER_ADDRESS as Address)

      console.log('Depositing to contract:', DEPOSIT_ROUTER_ADDRESS)
      console.log('Intent:', intent)
      console.log('Signature:', signature)
      writeContract({
        address: DEPOSIT_ROUTER_ADDRESS as Address,
        abi: DEPOSIT_ROUTER_ABI,
        functionName: 'depositWithIntent',
        args: [
          [
            intent.user,
            intent.vault,
            intent.asset,
            intent.amount,
            intent.nonce,
            intent.deadline
          ],
          signature as `0x${string}`
        ],
      })
      
    } catch (error) {
      console.error('Deposit failed:', error)
      alert('Deposit failed: ' + (error as Error).message)
      setCurrentTxType(null)
    } finally {
      setLoading(false)
    }
  }

  const handleExecuteDeposit = async (intentHash?: `0x${string}` | string | unknown) => {
    let hashToExecute: `0x${string}` | null = null
    
    if (intentHash) {
      let hashStr: string | null = null
      
      if (typeof intentHash === 'string') {
        hashStr = intentHash
      } else if (intentHash && typeof intentHash === 'object' && 'toString' in intentHash) {
        hashStr = String(intentHash)
      }
      
      if (hashStr) {
        hashToExecute = hashStr.startsWith('0x') ? hashStr as `0x${string}` : `0x${hashStr}` as `0x${string}`
      }
    } else if (pendingIntentHash && typeof pendingIntentHash === 'string') {
      hashToExecute = pendingIntentHash
    }
    
    if (!hashToExecute || typeof hashToExecute !== 'string' || !hashToExecute.startsWith('0x') || hashToExecute.length !== 66) {
      alert('Invalid intent hash. Please try refreshing and selecting the intent again.')
      console.error('Invalid hash:', hashToExecute, 'type:', typeof hashToExecute)
      return
    }

    try {
      setLoading(true)
      setCurrentTxType('execute')
      setPendingIntentHash(hashToExecute)
      
      const isValid = await publicClient?.readContract({
        address: DEPOSIT_ROUTER_ADDRESS as Address,
        abi: DEPOSIT_ROUTER_ABI,
        functionName: 'isIntentValid',
        args: [hashToExecute],
      })

      if (!isValid) {
        const depositRecord = await publicClient?.readContract({
          address: DEPOSIT_ROUTER_ADDRESS as Address,
          abi: DEPOSIT_ROUTER_ABI,
          functionName: 'getDeposit',
          args: [hashToExecute],
        }) as any

        if (!depositRecord || depositRecord.user === '0x0000000000000000000000000000000000000000') {
          alert('Intent not found. It may not have been created yet.')
        } else if (depositRecord.executed) {
          alert('This intent has already been executed.')
        } else if (depositRecord.cancelled) {
          alert('This intent was cancelled.')
        } else if (BigInt(depositRecord.deadline) < BigInt(Math.floor(Date.now() / 1000))) {
          alert('This intent has expired. Please create a new one.')
        } else {
          alert('Intent is not valid for execution.')
        }
        setLoading(false)
        setCurrentTxType(null)
        return
      }

      const currentAllowance = await publicClient?.readContract({
        address: USDC_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [address!, DEPOSIT_ROUTER_ADDRESS as Address],
      }) as bigint

      const depositRecord = await publicClient?.readContract({
        address: DEPOSIT_ROUTER_ADDRESS as Address,
        abi: DEPOSIT_ROUTER_ABI,
        functionName: 'getDeposit',
        args: [hashToExecute],
      }) as any

      if (currentAllowance < BigInt(depositRecord.amount)) {
        alert(`Insufficient allowance. You need to approve ${formatUnits(BigInt(depositRecord.amount), 6)} USDC. Current allowance: ${formatUnits(currentAllowance, 6)} USDC`)
        setLoading(false)
        setCurrentTxType(null)
        return
      }
      
      writeContract({
        address: DEPOSIT_ROUTER_ADDRESS as Address,
        abi: DEPOSIT_ROUTER_ABI,
        functionName: 'executeDeposit',
        args: [hashToExecute],
      })
      
    } catch (error: any) {
      console.error('Execute deposit failed:', error)
      setCurrentTxType(null)
      setLoading(false)
      alert('Failed to initiate transaction: ' + (error?.message || 'Unknown error'))
    }
  }

  useEffect(() => {
    if (writeError && currentTxType === 'execute') {
      console.log('Write error detected:', writeError)
      setLoading(false)
      setCurrentTxType(null)
      let errorMessage = 'Execute deposit failed: '
      
      if (writeError.message) {
        if (writeError.message.includes('Vault deposit failed')) {
          errorMessage += 'The vault rejected the deposit. The contract may need to be updated - controller should be the user, not the DepositRouter.'
        } else if (writeError.message.includes('reverted')) {
          const revertReason = writeError.message.split('reverted')[1]?.trim() || 'Transaction reverted'
          errorMessage += revertReason
        } else {
          errorMessage += writeError.message
        }
      } else {
        errorMessage += 'Unknown error occurred'
      }
      
      alert(errorMessage)
      resetWriteContract()
    }
  }, [writeError, currentTxType, resetWriteContract])

  useEffect(() => {
    if (isReceiptError && currentTxType === 'execute') {
      setLoading(false)
      setCurrentTxType(null)
      let errorMessage = 'Transaction failed: '
      
      if (receiptError?.message) {
        errorMessage += receiptError.message
      } else {
        errorMessage += 'Transaction was reverted'
      }
      
      alert(errorMessage)
      resetWriteContract()
    }
  }, [isReceiptError, receiptError, currentTxType, resetWriteContract])

  useEffect(() => {
    if (isSuccess && currentTxType === 'execute') {
      setLoading(false)
      setCurrentTxType(null)
      setExecuteSuccess(true)
      setExecutedHash(hash || null)
      
      if (pendingIntentHash) {
        setPendingIntents(prev => prev.filter(i => i.intentHash !== pendingIntentHash))
      }
      
      alert('✅ Deposit executed successfully! Your USDC has been deposited to the vault.')
      
      setTimeout(() => {
        fetchPendingIntents()
      }, 2000)
      
      setTimeout(() => {
        setExecuteSuccess(false)
        setExecutedHash(null)
      }, 10000)
    }
  }, [isSuccess, currentTxType, hash, pendingIntentHash])

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

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <h1 className="text-3xl sm:text-4xl font-bold mb-6 sm:mb-8">KOL Landing Page</h1>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8">
          <div className="border-2 border-black p-6 sm:p-8">
            <h2 className="text-xl sm:text-2xl font-bold mb-4 sm:mb-6">Deposit USDC</h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold mb-2">Amount (USDC)</label>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full border-2 border-black p-3 bg-white text-black focus:outline-none focus:ring-2 focus:ring-black"
                  placeholder="0.00"
                  step="0.01"
                  min="0"
                />
              </div>

              {allowance !== undefined && amount && (
                <div className={`text-sm p-3 border rounded ${
                  allowance >= parseUnits(amount, 6) 
                    ? 'bg-green-50 border-green-300 text-green-800' 
                    : 'bg-gray-50 border-gray-300 text-gray-600'
                }`}>
                  <p>
                    Allowance: <span className="font-semibold">{formatUnits(allowance as bigint, 6)} USDC</span>
                    {isApprovalConfirming && (
                      <span className="ml-2 text-xs">(Confirming...)</span>
                    )}
                  </p>
                  {allowance < parseUnits(amount, 6) && !isApprovalConfirming && (
                    <p className="text-red-600 mt-1 text-xs">Insufficient allowance. Please approve first.</p>
                  )}
                  {isApprovalSuccess && allowance < parseUnits(amount, 6) && (
                    <p className="text-blue-600 mt-1 text-xs">Approval confirmed! Refreshing allowance...</p>
                  )}
                </div>
              )}

              {allowance !== undefined && allowance < parseUnits(amount || '0', 6) && (
                <button
                  onClick={handleApprove}
                  disabled={loading || isPending || isApprovalConfirming || isApproving || !amount}
                  className="w-full bg-gray-800 text-white py-3 px-6 font-bold hover:bg-gray-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                >
                  {isApprovalConfirming ? 'Confirming Approval...' : isApproving || isPending ? 'Approving...' : 'Approve USDC'}
                </button>
              )}

              {isApprovalSuccess && (
                <div className="p-3 bg-green-50 border-2 border-green-500 rounded">
                  <p className="font-semibold text-green-800 text-sm">Approval successful!</p>
                  <p className="text-xs text-green-600 mt-1 break-all">Hash: {approvalHash}</p>
                </div>
              )}

              <button
                onClick={handleDeposit}
                disabled={loading || isPending || !amount || (allowance !== undefined && allowance < parseUnits(amount, 6))}
                className="w-full bg-black text-white py-3 px-6 font-bold hover:bg-gray-800 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                {loading || isPending ? 'Depositing...' : 'Deposit to Vault'}
              </button>

              {isConfirming && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded">
                  <p className="text-sm text-blue-700">Confirming transaction...</p>
                </div>
              )}

              {depositSuccess && (
                <div className="p-4 bg-green-50 border-2 border-green-500 rounded">
                  <p className="font-semibold text-green-800">✅ Deposit Successful!</p>
                  <p className="text-sm text-green-700 mt-1">Your USDC has been deposited to the vault.</p>
                  {depositHash && <p className="text-xs text-green-600 mt-2 break-all">Tx Hash: {depositHash}</p>}
                </div>
              )}

              {executeSuccess && (
                <div className="p-4 bg-green-50 border-2 border-green-500 rounded">
                  <p className="font-semibold text-green-800">✅ Deposit Executed Successfully!</p>
                  <p className="text-sm text-green-700 mt-1">Your USDC has been deposited to the vault.</p>
                  {executedHash && <p className="text-xs text-green-600 mt-1 break-all">Tx Hash: {executedHash}</p>}
                  <p className="text-sm text-green-700 mt-2">Your USDC has been transferred to the vault.</p>
                </div>
              )}
            </div>
          </div>

          {pendingIntents.length > 0 && (
          <div className="border-2 border-black p-6 sm:p-8">
            <div className="flex justify-between items-center mb-4 sm:mb-6">
              <h2 className="text-xl sm:text-2xl font-bold">Pending Deposit Intents (Legacy)</h2>
              <button
                onClick={fetchPendingIntents}
                disabled={loadingIntents || !address}
                className="bg-black text-white py-1.5 px-3 text-xs sm:text-sm font-semibold hover:bg-gray-800 disabled:bg-gray-400 transition-colors"
              >
                {loadingIntents ? 'Loading...' : 'Refresh'}
              </button>
            </div>

            {loadingIntents ? (
              <div className="text-center py-8">
                <p className="text-gray-600">Loading pending intents...</p>
              </div>
            ) : pendingIntents.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-gray-600">No pending intents</p>
                <p className="text-xs text-gray-500 mt-2">Create a deposit intent above to see it here.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {pendingIntents.map((intent: any) => (
                  <div key={intent.id || intent.intentHash} className="border border-gray-300 p-4 rounded">
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <p className="text-sm font-semibold">Amount: {formatUnits(BigInt(intent.amount || '0'), 6)} USDC</p>
                        <p className="text-xs text-gray-600 mt-1">Status: <span className="font-semibold text-yellow-600">{intent.status}</span></p>
                        <p className="text-xs text-gray-500 mt-1 break-all">Intent Hash: {intent.intentHash}</p>
                        <p className="text-xs text-gray-500 mt-1">Created: {new Date(intent.timestamp).toLocaleString()}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        let hash: string | null = null
                        
                        if (typeof intent.intentHash === 'string') {
                          hash = intent.intentHash.startsWith('0x') ? intent.intentHash : `0x${intent.intentHash}`
                        } else if (intent.intentHash && typeof intent.intentHash === 'object') {
                          hash = intent.intentHash.toString()
                          if (!hash.startsWith('0x')) hash = `0x${hash}`
                        }
                        
                        if (hash && hash.length === 66) {
                          handleExecuteDeposit(hash)
                        } else {
                          alert('Invalid intent hash format. Please refresh the page.')
                          console.error('Invalid intent hash:', intent.intentHash)
                        }
                      }}
                      disabled={(loading && currentTxType === 'execute') || (isPending && currentTxType === 'execute') || isConfirming}
                      className="w-full bg-green-600 text-white py-2 px-4 font-bold hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                    >
                      {(loading && currentTxType === 'execute') || (isPending && currentTxType === 'execute') ? 'Executing...' : 'Execute Deposit (Transfer USDC)'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          )}

          <div className="border-2 border-black p-6 sm:p-8">
            <div className="flex justify-between items-center mb-4 sm:mb-6">
              <h2 className="text-xl sm:text-2xl font-bold">Vault Information</h2>
              <button
                onClick={fetchVaultState}
                disabled={loading || !VAULT_ADDRESS}
                className="bg-black text-white py-1.5 px-3 text-xs sm:text-sm font-semibold hover:bg-gray-800 disabled:bg-gray-400 transition-colors"
              >
                {loading ? 'Loading...' : 'Refresh'}
              </button>
            </div>

            {vaultState ? (
              <div className="space-y-4 overflow-hidden">
                <div className="pb-3 border-b-2 border-black">
                  <h3 className="text-lg sm:text-xl font-bold break-words">{vaultState.name || 'Turtle Avalanche USDC'}</h3>
                  <p className="text-xs text-gray-600 mt-1 break-all font-mono">{VAULT_ADDRESS}</p>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:gap-4">
                  <div className="border border-gray-300 p-3 bg-gray-50">
                    <p className="text-xs text-gray-600 mb-1">Total Assets</p>
                    <p className="text-base sm:text-lg font-bold break-words">
                      {Number(formatUnits(vaultState.totalAssets || BigInt(0), vaultState.underlyingDecimals || 6)).toLocaleString('en-US', {
                        maximumFractionDigits: 2
                      })}
                    </p>
                    <p className="text-xs text-gray-600">USDC</p>
                  </div>
                  <div className="border border-gray-300 p-3 bg-gray-50">
                    <p className="text-xs text-gray-600 mb-1">Total Supply</p>
                    <p className="text-base sm:text-lg font-bold break-words">
                      {Number(formatUnits(vaultState.totalSupply || BigInt(0), vaultState.decimals || 18)).toLocaleString('en-US', {
                        maximumFractionDigits: 6
                      })}
                    </p>
                    <p className="text-xs text-gray-600">Shares</p>
                  </div>
                </div>

                {vaultState.sharePriceFormatted && (
                  <div className="border-2 border-black p-3 sm:p-4 bg-gray-50">
                    <p className="text-xs text-gray-600 mb-1">Share Price</p>
                    <p className="text-lg sm:text-xl font-bold">
                      {vaultState.sharePriceFormatted.toFixed(6)} USDC
                    </p>
                    <p className="text-xs text-gray-600">per share</p>
                  </div>
                )}

                <div className="space-y-2 pt-2 border-t border-gray-300">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-600">Deposit Epoch:</span>
                    <span className="font-semibold">{vaultState.depositEpochId ?? 'N/A'}</span>
                  </div>
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-600">Last Settled Deposit:</span>
                    <span className="font-semibold">{vaultState.lastDepositEpochIdSettled ?? 'N/A'}</span>
                  </div>
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-600">Redeem Epoch:</span>
                    <span className="font-semibold">{vaultState.redeemEpochId ?? 'N/A'}</span>
                  </div>
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-600">Last Settled Redeem:</span>
                    <span className="font-semibold">{vaultState.lastRedeemEpochIdSettled ?? 'N/A'}</span>
                  </div>
                </div>

                <div className="pt-2 border-t border-gray-300">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-600">Vault State:</span>
                    <span className={`font-semibold px-2 py-1 rounded text-xs ${
                      vaultState.state === 0 ? 'bg-green-100 text-green-800' : 
                      vaultState.state === 1 ? 'bg-yellow-100 text-yellow-800' : 
                      'bg-red-100 text-red-800'
                    }`}>
                      {vaultState.state === 0 ? 'Active' : 
                       vaultState.state === 1 ? 'Paused' : 
                       'Unknown'}
                    </span>
                  </div>
                </div>

                <div className="pt-3 border-t border-gray-300">
                  <a 
                    href={`https://snowtrace.io/address/${VAULT_ADDRESS}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center text-sm text-blue-600 hover:text-blue-800 hover:underline transition-colors"
                  >
                    View on Snowtrace →
                  </a>
                </div>
              </div>
            ) : loading ? (
              <div className="text-center py-8">
                <div className="animate-pulse">
                  <div className="h-4 bg-gray-200 rounded w-3/4 mx-auto mb-2"></div>
                  <p className="text-gray-600 text-sm">Loading vault information...</p>
                </div>
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-gray-600 mb-2">Vault address not configured</p>
                <p className="text-xs text-gray-500">Set NEXT_PUBLIC_LAGOON_VAULT_ADDRESS in .env.local</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}

