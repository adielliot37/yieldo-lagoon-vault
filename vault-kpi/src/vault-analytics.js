const LAGOON_TX_API = 'https://app.lagoon.finance/api/transaction-history';

const CHAIN_ID_MAP = {
  ethereum: 1,
  avalanche: 43114,
};

async function fetchAllTransactions(vaultAddress, chainId) {
  const transactions = [];
  let offset = 0;
  const limit = 100;
  let hasMore = true;
  let retries = 0;
  const maxRetries = 3;
  let consecutiveErrors = 0;

  while (hasMore && consecutiveErrors < 3) {
    const url = `${LAGOON_TX_API}?vaultAddress=${vaultAddress}&chainId=${chainId}&limit=${limit}&offset=${offset}&orderBy=blockNumber&orderDirection=desc&useMinimalFragment=true`;
    
    try {
      if (offset > 0) {
        await new Promise(r => setTimeout(r, 200));
      }
      
      const res = await fetch(url);
      
      if (!res.ok) {
        consecutiveErrors++;
        if (res.status === 500 && retries < maxRetries) {
          retries++;
          console.warn(`[vault-analytics] API error ${res.status}, retrying (${retries}/${maxRetries})...`);
          await new Promise(r => setTimeout(r, 1000 * retries));
          continue;
        }
        console.warn(`[vault-analytics] API error: ${res.status} at offset ${offset}`);
        if (transactions.length > 0) {
          console.log(`[vault-analytics] Continuing with ${transactions.length} transactions collected so far`);
        }
        break;
      }
      
      consecutiveErrors = 0;
      retries = 0;
      const data = await res.json();
      
      if (data.transactions && data.transactions.length > 0) {
        transactions.push(...data.transactions);
        offset += data.transactions.length;
        hasMore = data.hasNextPage === true;
        
        if (transactions.length % 500 === 0) {
          console.log(`[vault-analytics] Fetched ${transactions.length} transactions...`);
        }
      } else {
        hasMore = false;
      }
    } catch (e) {
      consecutiveErrors++;
      console.error(`[vault-analytics] Fetch error:`, e.message);
      if (retries < maxRetries) {
        retries++;
        await new Promise(r => setTimeout(r, 1000 * retries));
        continue;
      }
      break;
    }
  }

  return transactions;
}

function buildUserActivityMap(transactions) {
  const users = new Map();
  const now = Math.floor(Date.now() / 1000);

  for (const tx of transactions) {
    if (!tx.userAddress || 
        tx.userAddress === 'Curator' || 
        tx.userAddress === 'Valuation Oracle' ||
        tx.activityCategory === 'Settlement' ||
        tx.activityCategory === 'Valuation') {
      continue;
    }

    const address = tx.userAddress.toLowerCase();
    const timestamp = parseInt(tx.timestamp, 10);
    const amountUsd = parseFloat(tx.underlyingAssetAmountInUsd) || 0;
    const amount = tx.underlyingAssetAmount;

    if (!users.has(address)) {
      users.set(address, { 
        deposits: [], 
        withdrawals: [], 
        totalDepositedUsd: 0,
        totalWithdrawnUsd: 0,
      });
    }

    const user = users.get(address);

    if (tx.activityCategory === 'Deposit') {
      user.deposits.push({ timestamp, amountUsd, amount, txHash: tx.transactionHash });
      user.totalDepositedUsd += amountUsd;
      if (!user.firstDeposit || timestamp < user.firstDeposit) {
        user.firstDeposit = timestamp;
      }
    } else if (tx.activityCategory === 'Withdraw') {
      user.withdrawals.push({ timestamp, amountUsd, amount, txHash: tx.transactionHash });
      user.totalWithdrawnUsd += amountUsd;
    }

    user.lastActivity = Math.max(user.lastActivity || 0, timestamp);
  }

  for (const [address, user] of users) {
    user.netPositionUsd = user.totalDepositedUsd - user.totalWithdrawnUsd;
    user.isActive = user.netPositionUsd > 1;
  }

  return users;
}

function analyzeUserBehavior(users) {
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  
  const analytics = {
    totalUsers: 0,
    activeHolders: 0,
    exitedUsers: 0,
    avgHoldingDays: 0,
    medianHoldingDays: 0,
    holdersOver30Days: 0,
    holdersOver90Days: 0,
    holdersOver180Days: 0,
    quickExiters: 0,
    quickExitRate: 0,
    longTermHolders: [],
    smartDepositors: [],
    likelyFarmers: [],
    retentionRate: 0,
    churnRate: 0,
    avgDepositsPerUser: 0,
    usersWithMultipleDeposits: 0,
    totalDepositedUsd: 0,
    totalWithdrawnUsd: 0,
  };

  const holdingDays = [];
  let totalDeposits = 0;

  for (const [address, user] of users) {
    analytics.totalUsers++;
    totalDeposits += user.deposits.length;
    analytics.totalDepositedUsd += user.totalDepositedUsd;
    analytics.totalWithdrawnUsd += user.totalWithdrawnUsd;

    if (user.deposits.length > 1) {
      analytics.usersWithMultipleDeposits++;
    }

    const firstDeposit = user.firstDeposit;
    const firstWithdraw = user.withdrawals.length > 0 ? 
      Math.min(...user.withdrawals.map(w => w.timestamp)) : null;

    if (user.isActive) {
      analytics.activeHolders++;
      if (firstDeposit) {
        const holdingDuration = (now - firstDeposit) / DAY;
        holdingDays.push(holdingDuration);
        
        if (holdingDuration > 30) analytics.holdersOver30Days++;
        if (holdingDuration > 90) analytics.holdersOver90Days++;
        if (holdingDuration > 180) analytics.holdersOver180Days++;
        if (holdingDuration > 90) {
          analytics.longTermHolders.push({
            address,
            holdingDays: Math.round(holdingDuration),
            deposits: user.deposits.length,
            totalDepositedUsd: Math.round(user.totalDepositedUsd),
          });
        }
        if (user.deposits.length >= 2 && holdingDuration > 60) {
          analytics.smartDepositors.push({
            address,
            holdingDays: Math.round(holdingDuration),
            deposits: user.deposits.length,
            totalDepositedUsd: Math.round(user.totalDepositedUsd),
          });
        }
      }
    } else {
      analytics.exitedUsers++;
      if (firstDeposit && firstWithdraw) {
        const daysHeld = (firstWithdraw - firstDeposit) / DAY;
        
        if (daysHeld <= 7) {
          analytics.quickExiters++;
          analytics.likelyFarmers.push({
            address,
            daysHeld: Math.round(daysHeld * 10) / 10,
            deposits: user.deposits.length,
            withdrawals: user.withdrawals.length,
            volumeUsd: Math.round(user.totalDepositedUsd),
          });
        }
      }
    }
  }

  if (holdingDays.length > 0) {
    analytics.avgHoldingDays = Math.round(holdingDays.reduce((a, b) => a + b, 0) / holdingDays.length);
    holdingDays.sort((a, b) => a - b);
    analytics.medianHoldingDays = Math.round(holdingDays[Math.floor(holdingDays.length / 2)]);
  }

  if (analytics.totalUsers > 0) {
    analytics.avgDepositsPerUser = Math.round((totalDeposits / analytics.totalUsers) * 10) / 10;
    analytics.retentionRate = Math.round((analytics.activeHolders / analytics.totalUsers) * 100);
    analytics.churnRate = Math.round((analytics.exitedUsers / analytics.totalUsers) * 100);
  }

  if (analytics.exitedUsers > 0) {
    analytics.quickExitRate = Math.round((analytics.quickExiters / analytics.exitedUsers) * 100);
  }

  analytics.longTermHolders.sort((a, b) => b.holdingDays - a.holdingDays);
  analytics.smartDepositors.sort((a, b) => b.totalDepositedUsd - a.totalDepositedUsd);
  analytics.likelyFarmers.sort((a, b) => a.daysHeld - b.daysHeld);
  analytics.longTermHolders = analytics.longTermHolders.slice(0, 10);
  analytics.smartDepositors = analytics.smartDepositors.slice(0, 10);
  analytics.likelyFarmers = analytics.likelyFarmers.slice(0, 10);

  return analytics;
}

function calculateTrustScore(analytics) {
  let score = 50;
  score += (analytics.retentionRate / 100) * 20;
  score += Math.min(15, (analytics.avgHoldingDays / 90) * 15);
  score += (1 - analytics.quickExitRate / 100) * 15;
  if (analytics.totalUsers >= 10) {
    score += 10;
  } else {
    score += analytics.totalUsers;
  }
  if (analytics.holdersOver90Days >= 5) {
    score += 5;
  }

  return Math.min(100, Math.max(0, Math.round(score)));
}

export async function runVaultAnalytics(client, vaultConfig) {
  const chain = (vaultConfig.chain || '').toLowerCase();
  const chainId = CHAIN_ID_MAP[chain];
  
  if (!chainId) {
    console.warn(`[vault-analytics] Unknown chain: ${chain}`);
    return null;
  }

  const vaultAddress = vaultConfig.address?.toLowerCase();
  if (!vaultAddress) {
    console.warn(`[vault-analytics] Missing vault address for ${vaultConfig.id}`);
    return null;
  }

  console.log(`[vault-analytics] Fetching transaction history for ${vaultConfig.id} (${vaultAddress}, chainId=${chainId})...`);
  
  try {
    const transactions = await fetchAllTransactions(vaultAddress, chainId);
    console.log(`[vault-analytics] Found ${transactions.length} transactions`);
    
    if (transactions.length === 0) {
      console.warn(`[vault-analytics] No transactions found for ${vaultConfig.id}`);
      return {
        totalUsers: 0,
        activeHolders: 0,
        exitedUsers: 0,
        avgHoldingDays: 0,
        medianHoldingDays: 0,
        holdersOver30Days: 0,
        holdersOver90Days: 0,
        holdersOver180Days: 0,
        quickExiters: 0,
        quickExitRate: 0,
        retentionRate: 0,
        churnRate: 0,
        avgDepositsPerUser: 0,
        usersWithMultipleDeposits: 0,
        longTermHolders: [],
        smartDepositors: [],
        likelyFarmers: [],
        trustScore: 50,
        analyzedAt: new Date().toISOString(),
        transactionCount: 0,
        error: 'No transactions found - API may be temporarily unavailable',
      };
    }

    const users = buildUserActivityMap(transactions);
    const analytics = analyzeUserBehavior(users);
    const trustScore = calculateTrustScore(analytics);

    console.log(`[vault-analytics] ${vaultConfig.id}: ${analytics.totalUsers} users, ${analytics.activeHolders} active, ${analytics.retentionRate}% retention, Trust=${trustScore}`);

    return {
      ...analytics,
      trustScore,
      analyzedAt: new Date().toISOString(),
      transactionCount: transactions.length,
    };
  } catch (error) {
    console.error(`[vault-analytics] ${vaultConfig.id} failed:`, error.message);
    return null;
  }
}
