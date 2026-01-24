import express from 'express';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { avalanche } from 'viem/chains';
import { MongoClient } from 'mongodb';
import cron from 'node-cron';
import { Vault } from '@lagoon-protocol/v0-viem';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

app.use((req, res, next) => {
  const allowedOrigins = [
    'http://localhost:3000',
    'https://yieldo-vault.vercel.app',
    process.env.FRONTEND_URL
  ].filter(Boolean);
  
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

app.use(express.json());

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'yieldo';
if (!MONGODB_URI) {
  console.warn('Missing MONGODB_URI. Set it in your indexer env (MongoDB Atlas connection string).');
}

const mongoClient = MONGODB_URI ? new MongoClient(MONGODB_URI) : null;
let db;
let colIntents;
let colDeposits;
let colWithdrawals;
let colSnapshots;
let colMeta;

const client = createPublicClient({
  chain: avalanche,
  transport: http(process.env.AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc'),
});

const DEPOSIT_ROUTER_ADDRESS = process.env.DEPOSIT_ROUTER_ADDRESS;
const VAULT_ADDRESS = process.env.LAGOON_VAULT_ADDRESS;
const USDC_ADDRESS = process.env.USDC_ADDRESS || '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';

async function initDatabase() {
  if (!mongoClient) {
    throw new Error('MongoDB client not initialized (missing MONGODB_URI).');
  }

  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB_NAME);

  colIntents = db.collection('deposit_intents');
  colDeposits = db.collection('deposits');
  colWithdrawals = db.collection('withdrawals');
  colSnapshots = db.collection('snapshots');
  colMeta = db.collection('meta');

  // Drop existing non-unique indexes if they exist, then create unique ones
  try {
    // Try to drop existing transaction_hash indexes (they might not be unique)
    await colDeposits.dropIndex('transaction_hash_1').catch(() => {});
    await colWithdrawals.dropIndex('transaction_hash_1').catch(() => {});
  } catch (e) {
    // Ignore errors if indexes don't exist
  }

  await Promise.all([
    colIntents.createIndex({ intent_hash: 1 }, { unique: true }),
    colIntents.createIndex({ user_address: 1, created_at: -1 }),
    colDeposits.createIndex({ user_address: 1, created_at: -1 }),
    colDeposits.createIndex({ transaction_hash: 1 }, { unique: true }),
    colWithdrawals.createIndex({ transaction_hash: 1 }, { unique: true }),
    colWithdrawals.createIndex({ user_address: 1, created_at: -1 }),
    colSnapshots.createIndex({ date: 1, vault_address: 1 }, { unique: true }),
  ]);

  console.log('MongoDB initialized');
}

async function indexDepositRouterEvents(fromBlock, toBlock) {
  if (!DEPOSIT_ROUTER_ADDRESS) return;

  try {
    // Ensure we don't query blocks that haven't been finalized
    if (fromBlock > toBlock) {
      console.warn(`Invalid block range: fromBlock ${fromBlock} > toBlock ${toBlock}`);
      return;
    }

    const intentCreatedLogs = await client.getLogs({
      address: DEPOSIT_ROUTER_ADDRESS,
      event: parseAbiItem('event DepositIntentCreated(bytes32 indexed intentHash, address indexed user, address indexed vault, address asset, uint256 amount, uint256 nonce, uint256 deadline)'),
      fromBlock,
      toBlock,
    });

    for (const log of intentCreatedLogs) {
      const { intentHash, user, vault, asset, amount, nonce, deadline } = log.args;

      await colIntents.updateOne(
        { intent_hash: intentHash },
        {
          $setOnInsert: {
            intent_hash: intentHash,
            user_address: user,
            vault_address: vault,
            asset_address: asset,
            amount: amount.toString(),
            nonce: nonce.toString(),
            deadline: Number(deadline),
            status: 'pending',
            created_at: new Date(),
          },
        },
        { upsert: true }
      );
    }

    const depositExecutedLogs = await client.getLogs({
      address: DEPOSIT_ROUTER_ADDRESS,
      event: parseAbiItem('event DepositExecuted(bytes32 indexed intentHash, address indexed user, address indexed vault, uint256 amount)'),
      fromBlock,
      toBlock,
    });

    for (const log of depositExecutedLogs) {
      const { intentHash, user, vault, amount } = log.args;

      await colIntents.updateOne(
        { intent_hash: intentHash },
        { $set: { status: 'executed', executed_at: new Date() } }
      );

      await colDeposits.updateOne(
        { transaction_hash: log.transactionHash },
        {
          $set: {
            intent_hash: intentHash,
            user_address: user,
            vault_address: vault,
            amount: amount.toString(),
            status: 'executed',
            block_number: log.blockNumber.toString(),
            transaction_hash: log.transactionHash,
            executed_at: new Date(),
          },
          $setOnInsert: {
            shares: null,
            epoch_id: null,
            created_at: new Date(),
          },
        },
        { upsert: true }
      );
      
      console.log(`Deposit executed: ${intentHash} for user ${user}, amount: ${amount.toString()}`);
    }

    const feeCollectedLogs = await client.getLogs({
      address: DEPOSIT_ROUTER_ADDRESS,
      event: parseAbiItem('event FeeCollected(bytes32 indexed intentHash, address indexed asset, uint256 feeAmount)'),
      fromBlock,
      toBlock,
    });

    for (const log of feeCollectedLogs) {
      const { intentHash, asset, feeAmount } = log.args;
      console.log(`Fee collected: ${feeAmount.toString()} for intent ${intentHash}`);
    }

    const intentCancelledLogs = await client.getLogs({
      address: DEPOSIT_ROUTER_ADDRESS,
      event: parseAbiItem('event DepositIntentCancelled(bytes32 indexed intentHash, address indexed user)'),
      fromBlock,
      toBlock,
    });

    for (const log of intentCancelledLogs) {
      const { intentHash, user } = log.args;

      await colIntents.updateOne(
        { intent_hash: intentHash },
        { $set: { status: 'cancelled', cancelled_at: new Date() } }
      );
    }
  } catch (error) {
    // Handle "block not accepted" errors - throw so main loop can handle it
    if (error.message && (error.message.includes('after last accepted block') || error.message.includes('requested from block'))) {
      const finalityError = new Error(`Block range ${fromBlock}-${toBlock} not yet finalized`);
      finalityError.name = 'BlockNotFinalizedError';
      throw finalityError;
    }
    console.error('Error indexing DepositRouter events:', error);
    throw error; // Re-throw other errors
  }
}

async function indexVaultEvents(fromBlock, toBlock) {
  if (!VAULT_ADDRESS) return;

  try {
    // Ensure we don't query blocks that haven't been finalized
    if (fromBlock > toBlock) {
      console.warn(`Invalid block range: fromBlock ${fromBlock} > toBlock ${toBlock}`);
      return;
    }

    // Index DepositRequested events
    // Try ERC-7540 standard event first: DepositRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 assets)
    let depositRequestedLogs = [];
    try {
      depositRequestedLogs = await client.getLogs({
        address: VAULT_ADDRESS,
        event: parseAbiItem('event DepositRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 assets)'),
        fromBlock,
        toBlock,
      });
    } catch (e) {
      console.log('ERC-7540 DepositRequest event not found, trying Lagoon-specific format');
    }
    
    let lagoonDepositRequestedLogs = [];
    if (depositRequestedLogs.length === 0) {
      try {
        lagoonDepositRequestedLogs = await client.getLogs({
          address: VAULT_ADDRESS,
          event: parseAbiItem('event DepositRequested(address indexed user, uint256 indexed epochId, uint256 amount)'),
          fromBlock,
          toBlock,
        });
      } catch (e) {
        console.log('Lagoon DepositRequested event not found, vault may use different event format');
      }
    }

    for (const log of depositRequestedLogs) {
      const { controller, owner, requestId, sender, assets } = log.args;
      // Use owner as user, requestId as epoch_id (or map to epoch if needed)
      await colDeposits.updateOne(
        { user_address: owner, vault_address: VAULT_ADDRESS, status: 'pending' },
        { $set: { epoch_id: Number(requestId), status: 'requested', requested_amount: assets.toString() } },
        { sort: { created_at: -1 } }
      );
    }
    
    // Handle Lagoon-specific DepositRequested events (if different format)
    for (const log of lagoonDepositRequestedLogs) {
      const { user, epochId, amount } = log.args;
      await colDeposits.updateOne(
        { user_address: user, vault_address: VAULT_ADDRESS, status: 'pending' },
        { $set: { epoch_id: Number(epochId), status: 'requested', requested_amount: amount.toString() } },
        { sort: { created_at: -1 } }
      );
    }

    const depositSettledLogs = await client.getLogs({
      address: VAULT_ADDRESS,
      event: parseAbiItem('event DepositSettled(address indexed user, uint256 indexed epochId, uint256 shares)'),
      fromBlock,
      toBlock,
    });

    for (const log of depositSettledLogs) {
      const { user, epochId, shares } = log.args;

      await colDeposits.updateOne(
        { user_address: user, vault_address: VAULT_ADDRESS, epoch_id: Number(epochId) },
        { $set: { shares: shares.toString(), status: 'settled' } }
      );
    }

    // Index RedeemRequested events
    // Try ERC-7540 standard event first: RedeemRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares)
    let redeemRequestedLogs = [];
    try {
      redeemRequestedLogs = await client.getLogs({
        address: VAULT_ADDRESS,
        event: parseAbiItem('event RedeemRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares)'),
        fromBlock,
        toBlock,
      });
      if (redeemRequestedLogs.length > 0) {
        console.log(`Found ${redeemRequestedLogs.length} ERC-7540 RedeemRequest events in blocks ${fromBlock}-${toBlock}`);
      }
    } catch (e) {
      console.log(`Error querying ERC-7540 RedeemRequest: ${e.message}`);
    }
    
    // ALWAYS try querying by topic hash as fallback (even if first query succeeded)
    // ERC-7540 RedeemRequest topic[0] = keccak256("RedeemRequest(address,address,uint256,address,uint256)")
    // This is 0x1fdc681a13d8c5da54e301c7ce6542dcde4581e4725043fdab2db12ddc574506
    // This ensures we catch events even if the event signature parsing fails
    try {
      const topicHash = '0x1fdc681a13d8c5da54e301c7ce6542dcde4581e4725043fdab2db12ddc574506';
      const logsByTopic = await client.getLogs({
        address: VAULT_ADDRESS,
        topics: [topicHash],
        fromBlock,
        toBlock,
      });
      
      if (logsByTopic.length > 0) {
        console.log(`Found ${logsByTopic.length} logs with RedeemRequest topic hash in blocks ${fromBlock}-${toBlock}, attempting to decode...`);
        
        // Get existing transaction hashes to avoid duplicates
        const existingTxHashes = new Set(redeemRequestedLogs.map(l => l.transactionHash));
        
        // Try to decode these logs manually
        for (const log of logsByTopic) {
          // Skip if we already have this transaction from the first query
          if (existingTxHashes.has(log.transactionHash)) {
            continue;
          }
          
          try {
            // Decode manually: controller (topic[1]), owner (topic[2]), requestId (topic[3]), sender and shares in data
            const controller = '0x' + log.topics[1].slice(-40);
            const owner = '0x' + log.topics[2].slice(-40);
            const requestId = BigInt(log.topics[3]);
            
            // Decode data: sender (address, 32 bytes) + shares (uint256, 32 bytes)
            const sender = '0x' + log.data.slice(26, 66); // Skip 0x and padding, get address
            const shares = BigInt('0x' + log.data.slice(66, 130));
            
            // Create a log-like object that matches our expected format
            const decodedLog = {
              ...log,
              args: {
                controller,
                owner,
                requestId,
                sender,
                shares,
              },
            };
            redeemRequestedLogs.push(decodedLog);
            console.log(`Decoded RedeemRequest from topic hash: tx=${log.transactionHash}, owner=${owner}, requestId=${requestId}, shares=${shares}`);
          } catch (decodeError) {
            console.log(`Failed to decode log ${log.transactionHash}: ${decodeError.message}`);
            console.log(`  Log data: ${log.data}, topics: ${log.topics.length}`);
          }
        }
        if (redeemRequestedLogs.length > 0) {
          console.log(`Total RedeemRequest events after topic hash fallback: ${redeemRequestedLogs.length}`);
        }
      }
    } catch (e) {
      console.log(`Error querying by topic hash: ${e.message}`);
    }
    
    let lagoonRedeemRequestedLogs = [];
    try {
      lagoonRedeemRequestedLogs = await client.getLogs({
        address: VAULT_ADDRESS,
        event: parseAbiItem('event RedeemRequested(address indexed user, uint256 indexed epochId, uint256 shares)'),
        fromBlock,
        toBlock,
      });
      if (lagoonRedeemRequestedLogs.length > 0) {
        console.log(`Found ${lagoonRedeemRequestedLogs.length} Lagoon RedeemRequested events in blocks ${fromBlock}-${toBlock}`);
      }
    } catch (e) {
      console.log(`Error querying Lagoon RedeemRequested: ${e.message}`);
    }

    // Also try to get ALL logs from vault and see if we're missing any redeem-related events
    // This helps debug if the event signature is different
    try {
      const allVaultLogs = await client.getLogs({
        address: VAULT_ADDRESS,
        fromBlock,
        toBlock,
      });
      
      // Look for logs that might be redeem events by checking topic[0] (event signature)
      // RedeemRequested topic[0] would be keccak256("RedeemRequested(address,uint256,uint256)")
      // But we'll just log if we find logs we didn't catch
      const caughtTxHashes = new Set([
        ...redeemRequestedLogs.map(l => l.transactionHash),
        ...lagoonRedeemRequestedLogs.map(l => l.transactionHash),
      ]);
      
      const uncatchedLogs = allVaultLogs.filter(log => !caughtTxHashes.has(log.transactionHash));
      if (uncatchedLogs.length > 0 && Math.random() < 0.1) { // Log 10% of the time to avoid spam
        console.log(`Found ${uncatchedLogs.length} vault logs in blocks ${fromBlock}-${toBlock} that weren't caught by our event filters`);
        // Log first few for debugging
        uncatchedLogs.slice(0, 3).forEach(log => {
          console.log(`  Uncaught log: tx=${log.transactionHash}, topics=${log.topics.length}, block=${log.blockNumber}`);
        });
      }
    } catch (e) {
      // Ignore errors in debug logging
    }

    // Handle ERC-7540 RedeemRequest events
    for (const log of redeemRequestedLogs) {
      const { controller, owner, requestId, sender, shares } = log.args;
      console.log(`Processing ERC-7540 RedeemRequest: tx=${log.transactionHash}, owner=${owner}, requestId=${requestId}, shares=${shares}, block=${log.blockNumber}`);
      
      // Use owner as user, requestId as epoch_id
      const result = await colWithdrawals.updateOne(
        { transaction_hash: log.transactionHash },
        {
          $setOnInsert: {
            user_address: owner,
            vault_address: VAULT_ADDRESS,
            shares: shares.toString(),
            assets: null,
            epoch_id: Number(requestId),
            status: 'pending',
            block_number: log.blockNumber.toString(),
            transaction_hash: log.transactionHash,
            created_at: new Date(),
          },
        },
        { upsert: true }
      );
      
      if (result.upsertedCount > 0) {
        console.log(`✅ Inserted new withdrawal: tx=${log.transactionHash}`);
      } else if (result.matchedCount > 0) {
        console.log(`ℹ️  Withdrawal already exists: tx=${log.transactionHash}`);
      }
    }

    // Handle Lagoon-specific RedeemRequested events
    for (const log of lagoonRedeemRequestedLogs) {
      const { user, epochId, shares } = log.args;
      console.log(`Found RedeemRequested event: user=${user}, epochId=${epochId}, shares=${shares}, tx=${log.transactionHash}`);

      await colWithdrawals.updateOne(
        { transaction_hash: log.transactionHash },
        {
          $setOnInsert: {
            user_address: user,
            vault_address: VAULT_ADDRESS,
            shares: shares.toString(),
            assets: null,
            epoch_id: Number(epochId),
            status: 'pending',
            block_number: log.blockNumber.toString(),
            transaction_hash: log.transactionHash,
            created_at: new Date(),
          },
        },
        { upsert: true }
      );
      console.log(`Saved withdrawal to database: tx=${log.transactionHash}`);
    }

    // Log if no redeem events found (for debugging)
    if (redeemRequestedLogs.length === 0 && lagoonRedeemRequestedLogs.length === 0) {
      // Only log occasionally to avoid spam
      if (Math.random() < 0.01) { // 1% chance
        console.log(`No RedeemRequested events found in blocks ${fromBlock}-${toBlock}`);
      }
    }

    // Index RedeemSettled events
    // Try ERC-7540 standard event first: RedeemSettled(address indexed controller, address indexed owner, uint256 indexed requestId, address receiver, uint256 assets)
    let redeemSettledLogs = [];
    try {
      redeemSettledLogs = await client.getLogs({
        address: VAULT_ADDRESS,
        event: parseAbiItem('event RedeemSettled(address indexed controller, address indexed owner, uint256 indexed requestId, address receiver, uint256 assets)'),
        fromBlock,
        toBlock,
      });
    } catch (e) {
      console.log('ERC-7540 RedeemSettled event not found, trying Lagoon-specific format');
    }
    
    let lagoonRedeemSettledLogs = [];
    if (redeemSettledLogs.length === 0) {
      try {
        lagoonRedeemSettledLogs = await client.getLogs({
          address: VAULT_ADDRESS,
          event: parseAbiItem('event RedeemSettled(address indexed user, uint256 indexed epochId, uint256 assets)'),
          fromBlock,
          toBlock,
        });
      } catch (e) {
        console.log('Lagoon RedeemSettled event not found, vault may use different event format');
      }
    }

    // Handle ERC-7540 RedeemSettled events
    for (const log of redeemSettledLogs) {
      const { controller, owner, requestId, receiver, assets } = log.args;
      await colWithdrawals.updateOne(
        { user_address: owner, vault_address: VAULT_ADDRESS, epoch_id: Number(requestId) },
        { $set: { assets: assets.toString(), status: 'settled', settled_at: new Date() } }
      );
    }

    // Handle Lagoon-specific RedeemSettled events
    for (const log of lagoonRedeemSettledLogs) {
      const { user, epochId, assets } = log.args;

      await colWithdrawals.updateOne(
        { user_address: user, vault_address: VAULT_ADDRESS, epoch_id: Number(epochId) },
        { $set: { assets: assets.toString(), status: 'settled', settled_at: new Date() } }
      );
    }

    const totalAssetsUpdatedLogs = await client.getLogs({
      address: VAULT_ADDRESS,
      event: parseAbiItem('event TotalAssetsUpdated(uint256 totalAssets, uint256 timestamp)'),
      fromBlock,
      toBlock,
    });

    // These will be used in daily snapshots
  } catch (error) {
    // Handle "block not accepted" errors - throw so main loop can handle it
    if (error.message && (error.message.includes('after last accepted block') || error.message.includes('requested from block'))) {
      const finalityError = new Error(`Block range ${fromBlock}-${toBlock} not yet finalized`);
      finalityError.name = 'BlockNotFinalizedError';
      throw finalityError;
    }
    console.error('Error indexing vault events:', error);
    throw error; // Re-throw other errors
  }
}

async function createDailySnapshot() {
  if (!VAULT_ADDRESS) return;

  try {
    const vault = await Vault.fetch(VAULT_ADDRESS, client);
    if (!vault) {
      console.error('Failed to fetch vault');
      return;
    }

    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
    const dateKey = startOfDay.toISOString().slice(0, 10); // YYYY-MM-DD

    // Calculate total deposits and withdrawals for today (BigInt sums on base-unit strings)
    const depositsToday = await colDeposits
      .find({ created_at: { $gte: startOfDay, $lte: endOfDay } }, { projection: { amount: 1 } })
      .toArray();
    const totalDeposits = depositsToday.reduce((acc, d) => acc + BigInt(d.amount || '0'), 0n).toString();

    const withdrawalsToday = await colWithdrawals
      .find({ created_at: { $gte: startOfDay, $lte: endOfDay } }, { projection: { assets: 1 } })
      .toArray();
    const totalWithdrawals = withdrawalsToday
      .reduce((acc, w) => acc + BigInt(w.assets || '0'), 0n)
      .toString();

    await colSnapshots.updateOne(
      { date: dateKey, vault_address: VAULT_ADDRESS },
      {
        $set: {
          date: dateKey,
          vault_address: VAULT_ADDRESS,
          total_assets: vault.totalAssets?.toString() || '0',
          total_supply: vault.totalSupply?.toString() || '0',
          total_deposits: totalDeposits,
          total_withdrawals: totalWithdrawals,
          deposit_epoch_id: vault.depositEpochId || 0,
          redeem_epoch_id: vault.redeemEpochId || 0,
          created_at: new Date(),
        },
      },
      { upsert: true }
    );

    console.log(`Daily snapshot created for ${dateKey}`);
  } catch (error) {
    console.error('Error creating daily snapshot:', error);
  }
}

// Main indexing loop
let lastProcessedBlock = null;

async function startIndexing() {
  await initDatabase();

  // Restore last processed block from MongoDB meta (or start from 1000 blocks ago)
  const meta = await colMeta.findOne({ _id: 'lastProcessedBlock' });
  if (meta?.value) {
    lastProcessedBlock = BigInt(meta.value);
  } else {
    lastProcessedBlock = (await client.getBlockNumber()) - 1000n;
  }

  console.log(`Starting indexing from block ${lastProcessedBlock}`);

  // Helper function to get a safe block number that's definitely finalized
  // Avalanche requires blocks to be "accepted" before logs can be queried
  // Based on network conditions, this can take 20-100+ blocks
  // We use a configurable but conservative default margin
  async function getSafeBlockNumber() {
    const latestBlock = await client.getBlockNumber();
    // Use a large safety margin - can be configured via env var, default 60 blocks
    // This ensures we only query blocks that are definitely finalized
    const SAFETY_MARGIN = BigInt(process.env.AVALANCHE_SAFETY_MARGIN || '60');
    const safeBlock = latestBlock > SAFETY_MARGIN ? latestBlock - SAFETY_MARGIN : latestBlock;
    return safeBlock;
  }

  // Function to backfill a specific block range (for missed blocks)
  async function backfillBlockRange(fromBlock, toBlock) {
    try {
      console.log(`Backfilling blocks ${fromBlock} to ${toBlock}`);
      await indexDepositRouterEvents(fromBlock, toBlock);
      await indexVaultEvents(fromBlock, toBlock);
      console.log(`Successfully backfilled blocks ${fromBlock} to ${toBlock}`);
      return true;
    } catch (error) {
      console.error(`Error backfilling blocks ${fromBlock} to ${toBlock}:`, error);
      return false;
    }
  }

  // Index every 10 seconds
  setInterval(async () => {
    try {
      const latestBlock = await client.getBlockNumber();
      const safeBlock = await getSafeBlockNumber();
      const fromBlock = lastProcessedBlock + 1n;
      const toBlock = safeBlock;

      if (fromBlock <= toBlock) {
        console.log(`Indexing blocks ${fromBlock} to ${toBlock} (latest: ${latestBlock}, safe: ${safeBlock})`);
        
        // Try indexing, but only update lastProcessedBlock if successful
        try {
          await indexDepositRouterEvents(fromBlock, toBlock);
          await indexVaultEvents(fromBlock, toBlock);
          
          // Only update lastProcessedBlock if indexing was successful
          lastProcessedBlock = toBlock;
          await colMeta.updateOne(
            { _id: 'lastProcessedBlock' },
            { $set: { value: lastProcessedBlock.toString(), updated_at: new Date() } },
            { upsert: true }
          );
        } catch (indexError) {
          // If indexing fails due to block finality, don't update lastProcessedBlock
          if (indexError.name === 'BlockNotFinalizedError' || 
              (indexError.message && (
                indexError.message.includes('after last accepted block') || 
                indexError.message.includes('requested from block') ||
                indexError.message.includes('not yet finalized')
              ))) {
            // Silently skip - blocks will be indexed in next iteration
            return; // Exit early, don't update lastProcessedBlock
          }
          throw indexError; // Re-throw if it's a different error
        }
      }

      // Periodically check for gaps and backfill them (every 5 minutes)
      // This helps catch any blocks that were missed due to errors or finality issues
      const now = Date.now();
      const lastGapCheck = await colMeta.findOne({ _id: 'lastGapCheck' });
      const GAP_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

      if (!lastGapCheck || (now - lastGapCheck.value) > GAP_CHECK_INTERVAL) {
        // Check for gaps in the last 1000 blocks
        const checkFromBlock = lastProcessedBlock > 1000n ? lastProcessedBlock - 1000n : 0n;
        const checkToBlock = lastProcessedBlock;
        
        // This is a simple check - in production you might want more sophisticated gap detection
        // For now, we'll just try to backfill any blocks that are significantly behind
        if (checkFromBlock < lastProcessedBlock) {
          console.log(`Checking for gaps between blocks ${checkFromBlock} and ${checkToBlock}`);
          // Note: Actual gap detection would require checking which blocks have events
          // For now, this is a placeholder - you can enhance it later
        }

        await colMeta.updateOne(
          { _id: 'lastGapCheck' },
          { $set: { value: now, updated_at: new Date() } },
          { upsert: true }
        );
      }
    } catch (error) {
      console.error('Error in indexing loop:', error);
    }
  }, 10000); // Every 10 seconds

  cron.schedule('0 0 * * *', createDailySnapshot);
  console.log('Daily snapshot scheduler started');
}

app.get('/api/deposits', async (req, res) => {
  try {
    const { user } = req.query;
    const filter = user ? { user_address: user } : {};
    const docs = await colDeposits.find(filter).sort({ created_at: -1 }).limit(100).toArray();

    res.json(
      docs.map((d) => ({
        id: d._id?.toString(),
        user: d.user_address,
        vault: d.vault_address,
        amount: d.amount,
        status: d.status,
        timestamp: d.created_at?.toISOString?.() || new Date().toISOString(),
        epochId: d.epoch_id ?? null,
        shares: d.shares ?? null,
        txHash: d.transaction_hash ?? null,
      }))
    );
  } catch (error) {
    console.error('Error fetching deposits:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/snapshots', async (req, res) => {
  try {
    const docs = await colSnapshots.find({}).sort({ date: -1 }).limit(30).toArray();
    res.json(
      docs.map((s) => ({
        date: s.date,
        aum: s.total_assets,
        totalDeposits: s.total_deposits,
        totalWithdrawals: s.total_withdrawals,
        totalSupply: s.total_supply,
        depositEpochId: s.deposit_epoch_id,
        redeemEpochId: s.redeem_epoch_id,
      }))
    );
  } catch (error) {
    console.error('Error fetching snapshots:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/intents', async (req, res) => {
  try {
    const { user } = req.query;
    const filter = user ? { user_address: user } : {};
    const docs = await colIntents.find(filter).sort({ created_at: -1 }).limit(100).toArray();
    res.json(
      docs.map((i) => ({
        id: i._id?.toString(),
        intentHash: i.intent_hash,
        user: i.user_address,
        vault: i.vault_address,
        asset: i.asset_address,
        amount: i.amount,
        nonce: i.nonce,
        status: i.status,
        timestamp: i.created_at?.toISOString?.() || new Date().toISOString(),
        executedAt: i.executed_at?.toISOString?.() || null,
      }))
    );
  } catch (error) {
    console.error('Error fetching intents:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/withdrawals', async (req, res) => {
  try {
    const { user } = req.query;
    const filter = user ? { user_address: user } : {};
    const docs = await colWithdrawals.find(filter).sort({ created_at: -1 }).limit(100).toArray();
    res.json(
      docs.map((w) => ({
        id: w._id?.toString(),
        user: w.user_address,
        vault: w.vault_address,
        shares: w.shares,
        assets: w.assets,
        epochId: w.epoch_id ?? null,
        status: w.status,
        timestamp: w.created_at?.toISOString?.() || new Date().toISOString(),
        settledAt: w.settled_at?.toISOString?.() || null,
        blockNumber: w.block_number ?? null,
        txHash: w.transaction_hash ?? null,
      }))
    );
  } catch (error) {
    console.error('Error fetching withdrawals:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', lastBlock: lastProcessedBlock?.toString() });
});

// Debug endpoint to check what events were emitted in a transaction
app.get('/api/debug/tx', async (req, res) => {
  try {
    const { txHash } = req.query;
    
    if (!txHash) {
      return res.status(400).json({ error: 'txHash query parameter is required' });
    }

    // Get transaction receipt to see all events
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    
    if (!receipt) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Get all logs from this transaction
    const allLogs = receipt.logs || [];
    
    // Filter logs from the vault address
    const vaultLogs = allLogs.filter(log => 
      log.address.toLowerCase() === VAULT_ADDRESS?.toLowerCase()
    );

    // Try to decode known events
    const decodedEvents = [];
    for (const log of vaultLogs) {
      try {
        // Try to decode as RedeemRequested
        try {
          const decoded = parseAbiItem('event RedeemRequested(address indexed user, uint256 indexed epochId, uint256 shares)');
          // This is simplified - in production you'd use proper decoding
          decodedEvents.push({
            address: log.address,
            topics: log.topics,
            data: log.data,
            event: 'RedeemRequested (attempted)',
            blockNumber: log.blockNumber.toString(),
          });
        } catch (e) {
          decodedEvents.push({
            address: log.address,
            topics: log.topics,
            data: log.data,
            event: 'Unknown event',
            blockNumber: log.blockNumber.toString(),
          });
        }
      } catch (e) {
        decodedEvents.push({
          address: log.address,
          topics: log.topics,
          data: log.data,
          event: 'Could not decode',
          blockNumber: log.blockNumber.toString(),
        });
      }
    }

    res.json({
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      status: receipt.status,
      from: receipt.from,
      to: receipt.to,
      vaultAddress: VAULT_ADDRESS,
      totalLogs: allLogs.length,
      vaultLogs: vaultLogs.length,
      events: decodedEvents,
      allLogs: allLogs.map(log => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
      })),
    });
  } catch (error) {
    console.error('Error in debug tx endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to check all events from vault in a block range
app.get('/api/debug/events', async (req, res) => {
  try {
    const { fromBlock, toBlock } = req.query;
    
    if (!fromBlock || !toBlock) {
      return res.status(400).json({ error: 'fromBlock and toBlock query parameters are required' });
    }

    const from = BigInt(fromBlock);
    const to = BigInt(toBlock);

    // Get ALL logs from the vault (no event filter)
    const allLogs = await client.getLogs({
      address: VAULT_ADDRESS,
      fromBlock: from,
      toBlock: to,
    });

    res.json({
      fromBlock: from.toString(),
      toBlock: to.toString(),
      vaultAddress: VAULT_ADDRESS,
      totalEvents: allLogs.length,
      events: allLogs.map(log => ({
        blockNumber: log.blockNumber.toString(),
        transactionHash: log.transactionHash,
        address: log.address,
        topics: log.topics,
        data: log.data,
      })),
    });
  } catch (error) {
    console.error('Error in debug events endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Backfill endpoint to re-index specific block ranges
app.post('/api/backfill', async (req, res) => {
  try {
    const { fromBlock, toBlock } = req.body;
    
    if (!fromBlock || !toBlock) {
      return res.status(400).json({ error: 'fromBlock and toBlock are required' });
    }

    const from = BigInt(fromBlock);
    const to = BigInt(toBlock);

    if (from > to) {
      return res.status(400).json({ error: 'fromBlock must be <= toBlock' });
    }

    console.log(`Manual backfill requested for blocks ${from} to ${to}`);
    
    try {
      await indexDepositRouterEvents(from, to);
      await indexVaultEvents(from, to);
      
      res.json({ 
        success: true, 
        message: `Backfilled blocks ${from} to ${to}`,
        fromBlock: from.toString(),
        toBlock: to.toString()
      });
    } catch (backfillError) {
      // If it's a finality error, still return success but with a warning
      if (backfillError.name === 'BlockNotFinalizedError' || 
          (backfillError.message && backfillError.message.includes('not yet finalized'))) {
        res.status(202).json({ 
          success: true, 
          warning: 'Some blocks may not be finalized yet',
          message: `Attempted to backfill blocks ${from} to ${to}`,
          fromBlock: from.toString(),
          toBlock: to.toString()
        });
      } else {
        throw backfillError;
      }
    }
  } catch (error) {
    console.error('Error in backfill:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to backfill a single block
app.post('/api/backfill/block', async (req, res) => {
  try {
    const { blockNumber } = req.body;
    
    if (!blockNumber) {
      return res.status(400).json({ error: 'blockNumber is required' });
    }

    const block = BigInt(blockNumber);
    console.log(`Manual backfill requested for block ${block}`);
    
    try {
      await indexDepositRouterEvents(block, block);
      await indexVaultEvents(block, block);
      
      res.json({ 
        success: true, 
        message: `Backfilled block ${block}`,
        blockNumber: block.toString()
      });
    } catch (backfillError) {
      // If it's a finality error, still return success but with a warning
      if (backfillError.name === 'BlockNotFinalizedError' || 
          (backfillError.message && backfillError.message.includes('not yet finalized'))) {
        res.status(202).json({ 
          success: true, 
          warning: 'Block may not be finalized yet',
          message: `Attempted to backfill block ${block}`,
          blockNumber: block.toString()
        });
      } else {
        throw backfillError;
      }
    }
  } catch (error) {
    console.error('Error in block backfill:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Indexer API running on port ${PORT}`);
  startIndexing();
});

