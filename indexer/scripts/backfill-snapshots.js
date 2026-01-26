import { MongoClient } from 'mongodb';
import { createPublicClient, http } from 'viem';
import { avalanche } from 'viem/chains';
import { Vault } from '@lagoon-protocol/v0-viem';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'yieldo';
const VAULT_ADDRESS = process.env.LAGOON_VAULT_ADDRESS;

if (!MONGODB_URI) {
  console.error('❌ Missing MONGODB_URI in environment variables');
  process.exit(1);
}

if (!VAULT_ADDRESS) {
  console.error('❌ Missing LAGOON_VAULT_ADDRESS in environment variables');
  process.exit(1);
}

const client = createPublicClient({
  chain: avalanche,
  transport: http(process.env.AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc'),
});

async function backfillSnapshots() {
  const mongoClient = new MongoClient(MONGODB_URI);
  
  try {
    await mongoClient.connect();
    console.log('✅ Connected to MongoDB');
    
    const db = mongoClient.db(MONGODB_DB_NAME);
    const colDeposits = db.collection('deposits');
    const colWithdrawals = db.collection('withdrawals');
    const colSnapshots = db.collection('snapshots');
    
    const vault = await Vault.fetch(VAULT_ADDRESS, client);
    if (!vault) {
      console.error('❌ Failed to fetch vault');
      process.exit(1);
    }
    
    console.log('\n📊 Fetching all Yieldo deposits and withdrawals...');
    
    const allYieldoDeposits = await colDeposits
      .find({ 
        source: 'yieldo',
        status: { $in: ['executed', 'settled'] }
      })
      .toArray();
    
    const allYieldoWithdrawals = await colWithdrawals
      .find({ 
        source: 'yieldo',
        status: { $in: ['pending', 'settled'] }
      })
      .toArray();
    
    console.log(`Found ${allYieldoDeposits.length} Yieldo deposits and ${allYieldoWithdrawals.length} Yieldo withdrawals`);
    
    const depositsByDate = {};
    const withdrawalsByDate = {};
    
    for (const deposit of allYieldoDeposits) {
      if (!deposit.created_at) continue;
      const date = new Date(deposit.created_at);
      const dateKey = date.toISOString().slice(0, 10);
      
      if (!depositsByDate[dateKey]) {
        depositsByDate[dateKey] = 0n;
      }
      depositsByDate[dateKey] += BigInt(deposit.amount || '0');
    }
    
    for (const withdrawal of allYieldoWithdrawals) {
      if (!withdrawal.created_at) continue;
      const date = new Date(withdrawal.created_at);
      const dateKey = date.toISOString().slice(0, 10);
      
      if (!withdrawalsByDate[dateKey]) {
        withdrawalsByDate[dateKey] = 0n;
      }
      
      if (withdrawal.assets) {
        withdrawalsByDate[dateKey] += BigInt(withdrawal.assets);
      } else if (withdrawal.shares && vault.totalSupply > 0n) {
        try {
          const sharesBigInt = BigInt(withdrawal.shares);
          const estimatedAssets = vault.convertToAssets(sharesBigInt);
          withdrawalsByDate[dateKey] += estimatedAssets;
        } catch (error) {
          console.error(`Error converting shares for withdrawal ${withdrawal._id}:`, error);
        }
      }
    }
    
    const allDates = new Set([...Object.keys(depositsByDate), ...Object.keys(withdrawalsByDate)]);
    console.log(`\n📅 Found ${allDates.size} unique dates to process`);
    
    // Calculate cumulative deposits and withdrawals for each date
    const sortedDates = Array.from(allDates).sort();
    let cumulativeDeposits = 0n;
    let cumulativeWithdrawals = 0n;
    const aumByDate = {};
    
    for (const dateKey of sortedDates) {
      cumulativeDeposits += depositsByDate[dateKey] || 0n;
      cumulativeWithdrawals += withdrawalsByDate[dateKey] || 0n;
      // AUM approximation: cumulative deposits - cumulative withdrawals
      // Note: This doesn't account for yield/gains, but is better than showing entire vault AUM
      aumByDate[dateKey] = cumulativeDeposits - cumulativeWithdrawals;
    }
    
    // For the most recent date, calculate actual Yieldo AUM from current share balances
    if (sortedDates.length > 0) {
      const mostRecentDate = sortedDates[sortedDates.length - 1];
      const yieldoUsers = await colDeposits.distinct('user_address', {
        $or: [
          { source: 'yieldo' },
          { intent_hash: { $exists: true, $ne: null } }
        ],
        status: { $in: ['executed', 'settled', 'requested'] }
      });

      const erc4626Abi = [
        {
          inputs: [{ name: 'account', type: 'address' }],
          name: 'balanceOf',
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
          type: 'function',
        },
      ];

      console.log(`\n📊 Calculating actual Yieldo AUM from ${yieldoUsers.length} users for most recent date...`);
      let actualYieldoAUM = 0n;
      for (const user of yieldoUsers) {
        try {
          const userShares = await client.readContract({
            address: VAULT_ADDRESS,
            abi: erc4626Abi,
            functionName: 'balanceOf',
            args: [user],
          });
          
          if (vault.totalSupply > 0n && userShares > 0n) {
            const userAssets = vault.convertToAssets(userShares);
            actualYieldoAUM += userAssets;
          }
        } catch (error) {
          console.error(`Error fetching balance for user ${user}:`, error);
        }
      }
      
      // Use actual AUM for the most recent date
      aumByDate[mostRecentDate] = actualYieldoAUM;
    }
    
    let created = 0;
    let updated = 0;
    
    for (const dateKey of sortedDates) {
      const totalDeposits = (depositsByDate[dateKey] || 0n).toString();
      const totalWithdrawals = (withdrawalsByDate[dateKey] || 0n).toString();
      const yieldoAUM = (aumByDate[dateKey] || 0n).toString();
      
      const result = await colSnapshots.updateOne(
        { date: dateKey, vault_address: VAULT_ADDRESS },
        {
          $set: {
            date: dateKey,
            vault_address: VAULT_ADDRESS,
            total_assets: yieldoAUM, // Yieldo's AUM, not entire vault's AUM
            total_deposits: totalDeposits,
            total_withdrawals: totalWithdrawals,
            updated_at: new Date(),
          },
        },
        { upsert: true }
      );
      
      if (result.upsertedCount > 0) {
        created++;
        console.log(`✅ Created snapshot for ${dateKey}: deposits=${totalDeposits}, withdrawals=${totalWithdrawals}, AUM=${yieldoAUM}`);
      } else if (result.modifiedCount > 0) {
        updated++;
        console.log(`🔄 Updated snapshot for ${dateKey}: deposits=${totalDeposits}, withdrawals=${totalWithdrawals}, AUM=${yieldoAUM}`);
      }
    }
    
    console.log(`\n📊 Backfill Summary:`);
    console.log(`   Created: ${created} snapshots`);
    console.log(`   Updated: ${updated} snapshots`);
    console.log(`   Total dates processed: ${allDates.size}`);
    
    console.log('\n✅ Backfill completed successfully!');
    
  } catch (error) {
    console.error('❌ Backfill failed:', error);
    process.exit(1);
  } finally {
    await mongoClient.close();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

backfillSnapshots();


