import express from 'express';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { avalanche, mainnet } from 'viem/chains';
import { MongoClient } from 'mongodb';
import cron from 'node-cron';
import { Vault } from '@lagoon-protocol/v0-viem';
import dotenv from 'dotenv';
import { VAULTS_CONFIG, getVaultById } from './vaults-config.js';
import { indexDepositRouterEventsForVault, indexVaultEventsForVault } from './vault-indexer.js';

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
let colPendingYieldoWithdrawals;

const clients = {};

// Create clients with fallback support
for (const vault of VAULTS_CONFIG) {
  if (!clients[vault.chain]) {
    const primaryRpc = vault.rpcUrls[0];
    try {
      clients[vault.chain] = createPublicClient({
        chain: vault.chain === 'ethereum' ? mainnet : avalanche,
        transport: http(primaryRpc, {
          timeout: 30000, // 30 second timeout
          retryCount: 3,
        }),
      });
      console.log(`[${vault.chain}] Using RPC: ${primaryRpc}`);
    } catch (error) {
      console.error(`[${vault.chain}] Failed to create client with RPC ${primaryRpc}:`, error);
      // Try fallback RPCs
      for (let i = 1; i < vault.rpcUrls.length; i++) {
        try {
          console.log(`[${vault.chain}] Trying fallback RPC ${i + 1}: ${vault.rpcUrls[i]}`);
          clients[vault.chain] = createPublicClient({
            chain: vault.chain === 'ethereum' ? mainnet : avalanche,
            transport: http(vault.rpcUrls[i], {
              timeout: 30000,
              retryCount: 3,
            }),
          });
          console.log(`[${vault.chain}] Successfully using fallback RPC: ${vault.rpcUrls[i]}`);
          break;
        } catch (fallbackError) {
          console.error(`[${vault.chain}] Fallback RPC ${vault.rpcUrls[i]} also failed:`, fallbackError.message);
        }
      }
      if (!clients[vault.chain]) {
        throw new Error(`[${vault.chain}] All RPC endpoints failed for ${vault.chain}`);
      }
    }
  }
}

function getClientForVault(vaultConfig) {
  return clients[vaultConfig.chain];
}

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
  colPendingYieldoWithdrawals = db.collection('pending_yieldo_withdrawals');

  try {
    await colDeposits.dropIndex('transaction_hash_1').catch(() => {});
    await colWithdrawals.dropIndex('transaction_hash_1').catch(() => {});
  } catch (e) {}

  await Promise.all([
    colIntents.createIndex({ intent_hash: 1, chain: 1, vault_id: 1 }, { unique: true }),
    colIntents.createIndex({ user_address: 1, created_at: -1 }),
    colIntents.createIndex({ chain: 1, vault_id: 1 }),
    colDeposits.createIndex({ user_address: 1, created_at: -1 }),
    colDeposits.createIndex({ transaction_hash: 1, chain: 1 }, { unique: true }),
    colDeposits.createIndex({ chain: 1, vault_id: 1, created_at: -1 }),
    colDeposits.createIndex({ chain: 1, vault_address: 1 }),
    colDeposits.createIndex({ source: 1, chain: 1, vault_id: 1 }),
    colWithdrawals.createIndex({ transaction_hash: 1, chain: 1 }, { unique: true }),
    colWithdrawals.createIndex({ user_address: 1, created_at: -1 }),
    colWithdrawals.createIndex({ chain: 1, vault_id: 1, created_at: -1 }),
    colWithdrawals.createIndex({ chain: 1, vault_address: 1 }),
    colWithdrawals.createIndex({ source: 1, chain: 1, vault_id: 1 }),
    colSnapshots.createIndex({ date: 1, vault_id: 1, chain: 1 }, { unique: true }),
    colSnapshots.createIndex({ chain: 1, vault_id: 1, date: -1 }),
    colPendingYieldoWithdrawals.createIndex({ user_address: 1, created_at: -1 }),
    colPendingYieldoWithdrawals.createIndex({ transaction_hash: 1, chain: 1 }, { unique: true }),
    colPendingYieldoWithdrawals.createIndex({ created_at: 1 }, { expireAfterSeconds: 3600 }),
  ]);

  console.log('MongoDB initialized');
}

async function indexDepositRouterEvents(fromBlock, toBlock) {
  if (!DEPOSIT_ROUTER_ADDRESS) return;

  try {
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
            source: 'yieldo',
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
    if (error.message && (error.message.includes('after last accepted block') || error.message.includes('requested from block'))) {
      const finalityError = new Error(`Block range ${fromBlock}-${toBlock} not yet finalized`);
      finalityError.name = 'BlockNotFinalizedError';
      throw finalityError;
    }
    console.error('Error indexing DepositRouter events:', error);
    throw error;
  }
}

async function indexVaultEvents(fromBlock, toBlock) {
  if (!VAULT_ADDRESS) return;

  try {
    if (fromBlock > toBlock) {
      console.warn(`Invalid block range: fromBlock ${fromBlock} > toBlock ${toBlock}`);
      return;
    }
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
      const existingDeposit = await colDeposits.findOne(
        { user_address: owner, vault_address: VAULT_ADDRESS, status: 'pending' },
        { sort: { created_at: -1 } }
      );
      let source = 'lagoon';
      if (existingDeposit) {
        if (existingDeposit.source === 'yieldo' || existingDeposit.intent_hash) {
          source = 'yieldo';
        }
      }
      
      await colDeposits.updateOne(
        { user_address: owner, vault_address: VAULT_ADDRESS, status: 'pending' },
        { 
          $set: { 
            epoch_id: Number(requestId), 
            status: 'requested', 
            requested_amount: assets.toString(),
            source: source
          } 
        },
        { sort: { created_at: -1 } }
      );
    }
    
    for (const log of lagoonDepositRequestedLogs) {
      const { user, epochId, amount } = log.args;
      const existingDeposit = await colDeposits.findOne(
        { user_address: user, vault_address: VAULT_ADDRESS, status: 'pending' },
        { sort: { created_at: -1 } }
      );
      let source = 'lagoon';
      if (existingDeposit) {
        if (existingDeposit.source === 'yieldo' || existingDeposit.intent_hash) {
          source = 'yieldo';
        }
      }
      
      await colDeposits.updateOne(
        { user_address: user, vault_address: VAULT_ADDRESS, status: 'pending' },
        { 
          $set: { 
            epoch_id: Number(epochId), 
            status: 'requested', 
            requested_amount: amount.toString(),
            source: source
          } 
        },
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
        const existingTxHashes = new Set(redeemRequestedLogs.map(l => l.transactionHash));
        for (const log of logsByTopic) {
          if (existingTxHashes.has(log.transactionHash)) {
            continue;
          }

          if (log.topics.length !== 4) {
            console.log(`Skipping log ${log.transactionHash}: expected 4 topics, got ${log.topics.length}`);
            continue;
          }
          
          if (!log.data || log.data.length < 130) {
            console.log(`Skipping log ${log.transactionHash}: data too short (expected 130 chars, got ${log.data?.length || 0})`);
            continue;
          }

          try {
            if (!log.topics[1] || !log.topics[2] || !log.topics[3]) {
              throw new Error('Missing required topics');
            }
            
            const controller = '0x' + log.topics[1].slice(-40);
            const owner = '0x' + log.topics[2].slice(-40);
            const requestId = BigInt(log.topics[3]);
            const sender = '0x' + log.data.slice(26, 66);
            const sharesData = log.data.slice(66, 130);
            if (!sharesData || sharesData.length !== 64) {
              throw new Error(`Invalid shares data length: ${sharesData?.length || 0}`);
            }
            const shares = BigInt('0x' + sharesData);
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
            console.log(`✅ Decoded RedeemRequest from topic hash: tx=${log.transactionHash}, owner=${owner}, requestId=${requestId}, shares=${shares}`);
          } catch (decodeError) {
            console.log(`⚠️  Failed to decode log ${log.transactionHash}: ${decodeError.message}`);
            console.log(`  Log structure: topics=${log.topics.length}, dataLength=${log.data?.length || 0}`);
            if (log.topics.length >= 2) {
              console.log(`  Topic[1] (controller): ${log.topics[1]}`);
              console.log(`  Topic[2] (owner): ${log.topics[2]}`);
            }
            if (log.topics.length >= 4) {
              console.log(`  Topic[3] (requestId): ${log.topics[3]}`);
            }
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

    try {
      const allVaultLogs = await client.getLogs({
        address: VAULT_ADDRESS,
        fromBlock,
        toBlock,
      });
      
      const caughtTxHashes = new Set([
        ...redeemRequestedLogs.map(l => l.transactionHash),
        ...lagoonRedeemRequestedLogs.map(l => l.transactionHash),
      ]);
      
      const uncatchedLogs = allVaultLogs.filter(log => !caughtTxHashes.has(log.transactionHash));
      if (uncatchedLogs.length > 0 && Math.random() < 0.1) {
        console.log(`Found ${uncatchedLogs.length} vault logs in blocks ${fromBlock}-${toBlock} that weren't caught by our event filters`);
        uncatchedLogs.slice(0, 3).forEach(log => {
          console.log(`  Uncaught log: tx=${log.transactionHash}, topics=${log.topics.length}, block=${log.blockNumber}`);
        });
      }
    } catch (e) {}

    for (const log of redeemRequestedLogs) {
      const { controller, owner, requestId, sender, shares } = log.args;
      console.log(`Processing ERC-7540 RedeemRequest: tx=${log.transactionHash}, owner=${owner}, requestId=${requestId}, shares=${shares}, block=${log.blockNumber}`);
      
      const pendingMarker = await colPendingYieldoWithdrawals.findOne({
        transaction_hash: log.transactionHash
      });
      
      const source = pendingMarker ? 'yieldo' : 'lagoon';
      
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
            source: source,
            created_at: new Date(),
          },
        },
        { upsert: true }
      );
      
      if (result.upsertedCount > 0) {
        console.log(`✅ Inserted new withdrawal: tx=${log.transactionHash}, source=${source}`);
        if (pendingMarker) {
          await colPendingYieldoWithdrawals.deleteOne({ transaction_hash: log.transactionHash });
        }
      } else if (result.matchedCount > 0) {
        if (pendingMarker) {
          await colWithdrawals.updateOne(
            { transaction_hash: log.transactionHash },
            { $set: { source: 'yieldo' } }
          );
          await colPendingYieldoWithdrawals.deleteOne({ transaction_hash: log.transactionHash });
          console.log(`✅ Updated withdrawal source to Yieldo: tx=${log.transactionHash}`);
        }
        console.log(`ℹ️  Withdrawal already exists: tx=${log.transactionHash}`);
      }
    }

    for (const log of lagoonRedeemRequestedLogs) {
      const { user, epochId, shares } = log.args;
      console.log(`Found RedeemRequested event: user=${user}, epochId=${epochId}, shares=${shares}, tx=${log.transactionHash}`);

      const pendingMarker = await colPendingYieldoWithdrawals.findOne({
        transaction_hash: log.transactionHash
      });
      
      const source = pendingMarker ? 'yieldo' : 'lagoon';

      const result = await colWithdrawals.updateOne(
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
            source: source,
            created_at: new Date(),
          },
        },
        { upsert: true }
      );
      
      if (result.upsertedCount > 0) {
        console.log(`Saved withdrawal to database: tx=${log.transactionHash}, source=${source}`);
        if (pendingMarker) {
          await colPendingYieldoWithdrawals.deleteOne({ transaction_hash: log.transactionHash });
        }
      } else if (result.matchedCount > 0) {
        if (pendingMarker) {
          await colWithdrawals.updateOne(
            { transaction_hash: log.transactionHash },
            { $set: { source: 'yieldo' } }
          );
          await colPendingYieldoWithdrawals.deleteOne({ transaction_hash: log.transactionHash });
          console.log(`✅ Updated withdrawal source to Yieldo: tx=${log.transactionHash}`);
        }
      }
    }

    if (redeemRequestedLogs.length === 0 && lagoonRedeemRequestedLogs.length === 0) {
      if (Math.random() < 0.01) {
        console.log(`No RedeemRequested events found in blocks ${fromBlock}-${toBlock}`);
      }
    }
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

    for (const log of redeemSettledLogs) {
      const { controller, owner, requestId, receiver, assets } = log.args;
      await colWithdrawals.updateOne(
        { user_address: owner, vault_address: VAULT_ADDRESS, epoch_id: Number(requestId) },
        { $set: { assets: assets.toString(), status: 'settled', settled_at: new Date() } }
      );
    }

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

  } catch (error) {
    if (error.message && (error.message.includes('after last accepted block') || error.message.includes('requested from block'))) {
      const finalityError = new Error(`Block range ${fromBlock}-${toBlock} not yet finalized`);
      finalityError.name = 'BlockNotFinalizedError';
      throw finalityError;
    }
    console.error('Error indexing vault events:', error);
    throw error;
  }
}

async function createDailySnapshot() {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  const dateKey = startOfDay.toISOString().slice(0, 10);

  const snapshotPromises = VAULTS_CONFIG.map(async (vaultConfig) => {
    try {
      const client = getClientForVault(vaultConfig);
      const vault = await Vault.fetch(vaultConfig.address, client);
      if (!vault) {
        console.error(`[${vaultConfig.id}] Failed to fetch vault`);
        return;
      }

      const yieldoDepositsToday = await colDeposits
        .find({ 
          vault_id: vaultConfig.id,
          chain: vaultConfig.chain,
          source: 'yieldo',
          created_at: { $gte: startOfDay, $lte: endOfDay },
          status: { $in: ['executed', 'settled', 'requested'] }
        })
        .toArray();
      
      const totalDeposits = yieldoDepositsToday.reduce(
        (acc, d) => acc + BigInt(d.amount || '0'), 
        0n
      ).toString();

      const yieldoWithdrawalsToday = await colWithdrawals
        .find({ 
          vault_id: vaultConfig.id,
          chain: vaultConfig.chain,
          source: 'yieldo',
          created_at: { $gte: startOfDay, $lte: endOfDay },
          status: { $in: ['pending', 'settled'] }
        })
        .toArray();
      
      let totalWithdrawals = 0n;
      for (const w of yieldoWithdrawalsToday) {
        if (w.assets) {
          totalWithdrawals += BigInt(w.assets);
        } else if (w.shares && vault.totalSupply > 0n) {
          try {
            const sharesBigInt = BigInt(w.shares);
            const estimatedAssets = vault.convertToAssets(sharesBigInt);
            totalWithdrawals += estimatedAssets;
          } catch (error) {
            console.error(`[${vaultConfig.id}] Error converting shares to assets for withdrawal ${w._id}:`, error);
          }
        }
      }

      const yieldoUsers = await colDeposits.distinct('user_address', {
        vault_id: vaultConfig.id,
        chain: vaultConfig.chain,
        $or: [
          { source: 'yieldo' },
          { intent_hash: { $exists: true, $ne: null } }
        ],
        status: { $in: ['executed', 'settled', 'requested'] }
      });

      let yieldoAUM = 0n;
      const erc4626Abi = [
        {
          inputs: [{ name: 'account', type: 'address' }],
          name: 'balanceOf',
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
          type: 'function',
        },
      ];

      for (const user of yieldoUsers) {
        try {
          const userShares = await client.readContract({
            address: vaultConfig.address,
            abi: erc4626Abi,
            functionName: 'balanceOf',
            args: [user],
          });
          
          if (vault.totalSupply > 0n && userShares > 0n) {
            const userAssets = vault.convertToAssets(userShares);
            yieldoAUM += userAssets;
          }
        } catch (error) {
          console.error(`[${vaultConfig.id}] Error fetching balance for user ${user}:`, error);
        }
      }

      await colSnapshots.updateOne(
        { date: dateKey, vault_id: vaultConfig.id, chain: vaultConfig.chain },
        {
          $set: {
            date: dateKey,
            vault_id: vaultConfig.id,
            vault_address: vaultConfig.address,
            vault_name: vaultConfig.name,
            chain: vaultConfig.chain,
            asset_symbol: vaultConfig.asset.symbol,
            asset_decimals: vaultConfig.asset.decimals,
            total_assets: yieldoAUM.toString(),
            total_supply: vault.totalSupply?.toString() || '0',
            total_deposits: totalDeposits,
            total_withdrawals: totalWithdrawals.toString(),
            deposit_epoch_id: vault.depositEpochId || 0,
            redeem_epoch_id: vault.redeemEpochId || 0,
            created_at: new Date(),
          },
        },
        { upsert: true }
      );

      const depositsFormatted = (BigInt(totalDeposits) / BigInt(10 ** vaultConfig.asset.decimals)).toString();
      const withdrawalsFormatted = (totalWithdrawals / BigInt(10 ** vaultConfig.asset.decimals)).toString();
      const aumFormatted = (yieldoAUM / BigInt(10 ** vaultConfig.asset.decimals)).toString();
      console.log(`[${vaultConfig.id}] Daily snapshot created for ${dateKey}: deposits=${depositsFormatted} ${vaultConfig.asset.symbol}, withdrawals=${withdrawalsFormatted} ${vaultConfig.asset.symbol}, AUM=${aumFormatted} ${vaultConfig.asset.symbol}`);
    } catch (error) {
      console.error(`[${vaultConfig.id}] Error creating daily snapshot:`, error);
    }
  });

  await Promise.allSettled(snapshotPromises);

  try {
    const allSnapshots = await colSnapshots.find({ date: dateKey }).toArray();
    let combinedAUM = 0n;
    let combinedDeposits = 0n;
    let combinedWithdrawals = 0n;
    
    for (const snapshot of allSnapshots) {
      combinedAUM += BigInt(snapshot.total_assets || '0');
      combinedDeposits += BigInt(snapshot.total_deposits || '0');
      combinedWithdrawals += BigInt(snapshot.total_withdrawals || '0');
    }
    
    console.log(`[Combined] Total AUM across all vaults for ${dateKey}: ${(combinedAUM / BigInt(1e6)).toString()} USDC`);
  } catch (error) {
    console.error('Error calculating combined AUM:', error);
  }
}

const lastProcessedBlocks = {};

async function startIndexing() {
  await initDatabase();

  // Test RPC connections before starting
  for (const vault of VAULTS_CONFIG) {
    const client = getClientForVault(vault);
    try {
      console.log(`[${vault.chain}] Testing RPC connection...`);
      const testBlock = await client.getBlockNumber();
      console.log(`[${vault.chain}] ✅ RPC connection successful. Latest block: ${testBlock}`);
      
      // Test eth_getLogs support
      try {
        await client.getLogs({
          address: vault.address,
          fromBlock: testBlock - 10n,
          toBlock: testBlock,
        });
        console.log(`[${vault.chain}] ✅ RPC supports eth_getLogs`);
      } catch (logsError) {
        console.error(`[${vault.chain}] ❌ RPC does NOT support eth_getLogs:`, logsError.message);
        if (logsError.message && logsError.message.includes('eth_getLogs')) {
          console.error(`[${vault.chain}] CRITICAL: Current RPC (${vault.rpcUrls[0]}) does not support eth_getLogs method!`);
          console.error(`[${vault.chain}] Please set ${vault.chain.toUpperCase()}_RPC_URL environment variable to a working RPC endpoint`);
        }
      }
    } catch (error) {
      console.error(`[${vault.chain}] ❌ RPC connection failed:`, error.message);
      console.error(`[${vault.chain}] Current RPC URL: ${vault.rpcUrls[0]}`);
      throw new Error(`Failed to connect to ${vault.chain} RPC: ${error.message}`);
    }
  }

  for (const vault of VAULTS_CONFIG) {
    const metaKey = `lastProcessedBlock_${vault.chain}`;
    const meta = await colMeta.findOne({ _id: metaKey });
    const client = getClientForVault(vault);
    
    try {
      if (meta?.value) {
        lastProcessedBlocks[vault.chain] = BigInt(meta.value);
      } else {
        const latestBlock = await client.getBlockNumber();
        lastProcessedBlocks[vault.chain] = latestBlock - 100n;
        await colMeta.updateOne(
          { _id: metaKey },
          { $set: { value: lastProcessedBlocks[vault.chain].toString(), updated_at: new Date() } },
          { upsert: true }
        );
      }
      
      console.log(`[${vault.chain}] Starting indexing from block ${lastProcessedBlocks[vault.chain]}`);
    } catch (error) {
      console.error(`[${vault.chain}] Failed to initialize indexing:`, error.message);
      throw error;
    }
  }

  async function getSafeBlockNumber() {
    const latestBlock = await client.getBlockNumber();
    const SAFETY_MARGIN = BigInt(process.env.AVALANCHE_SAFETY_MARGIN || '60');
    const safeBlock = latestBlock > SAFETY_MARGIN ? latestBlock - SAFETY_MARGIN : latestBlock;
    return safeBlock;
  }

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

  setInterval(async () => {
    try {
      const indexingPromises = VAULTS_CONFIG.map(async (vault) => {
        try {
          const client = getClientForVault(vault);
          const latestBlock = await client.getBlockNumber();
          const SAFETY_MARGIN = vault.safetyMargin || BigInt(process.env[`${vault.chain.toUpperCase()}_SAFETY_MARGIN`] || '5');
          const safeBlock = latestBlock > SAFETY_MARGIN ? latestBlock - SAFETY_MARGIN : latestBlock;
          const fromBlock = lastProcessedBlocks[vault.chain] + 1n;
          const toBlock = safeBlock;

          if (fromBlock <= toBlock) {
            console.log(`[${vault.id}] Indexing blocks ${fromBlock} to ${toBlock} (latest: ${latestBlock}, safe: ${safeBlock})`);
            
            try {
              if (vault.depositRouter) {
                await indexDepositRouterEventsForVault(
                  vault,
                  client,
                  colIntents,
                  colDeposits,
                  fromBlock,
                  toBlock
                );
              }
              await indexVaultEventsForVault(
                vault,
                client,
                colDeposits,
                colWithdrawals,
                colPendingYieldoWithdrawals,
                colIntents,
                colMeta,
                fromBlock,
                toBlock
              );
              
              lastProcessedBlocks[vault.chain] = toBlock;
              const metaKey = `lastProcessedBlock_${vault.chain}`;
              await colMeta.updateOne(
                { _id: metaKey },
                { $set: { value: lastProcessedBlocks[vault.chain].toString(), updated_at: new Date() } },
                { upsert: true }
              );
            } catch (indexError) {
              if (indexError.name === 'BlockNotFinalizedError' || 
                  (indexError.message && (
                    indexError.message.includes('after last accepted block') || 
                    indexError.message.includes('requested from block') ||
                    indexError.message.includes('not yet finalized')
                  ))) {
                return;
              }
              // Enhanced error logging
              console.error(`[${vault.id}] Indexing error:`, indexError);
              if (indexError.message) {
                console.error(`[${vault.id}] Error message: ${indexError.message}`);
              }
              if (indexError.code) {
                console.error(`[${vault.id}] Error code: ${indexError.code}`);
              }
              if (indexError.shortMessage) {
                console.error(`[${vault.id}] Short message: ${indexError.shortMessage}`);
              }
              // Check if it's an RPC method error (like eth_getLogs not supported)
              if (indexError.message && indexError.message.includes('eth_getLogs')) {
                console.error(`[${vault.id}] CRITICAL: RPC does not support eth_getLogs. Current RPC: ${vault.rpcUrls[0]}`);
                console.error(`[${vault.id}] Please check ETHEREUM_RPC_URL environment variable on Railway`);
              }
              throw indexError;
            }
          }
        } catch (error) {
          // Enhanced error logging for debugging
          console.error(`[${vault.id}] Error in indexing loop:`, error);
          if (error.message) {
            console.error(`[${vault.id}] Error message: ${error.message}`);
          }
          if (error.code) {
            console.error(`[${vault.id}] Error code: ${error.code}`);
          }
          if (error.cause) {
            console.error(`[${vault.id}] Error cause:`, error.cause);
          }
          // Log RPC URL being used
          const client = getClientForVault(vault);
          console.error(`[${vault.id}] Using RPC: ${vault.rpcUrls[0]} for chain ${vault.chain}`);
        }
      });

      await Promise.allSettled(indexingPromises);

    } catch (error) {
      console.error('Error in indexing loop:', error);
    }
  }, 5000);

  cron.schedule('0 0 * * *', createDailySnapshot);
  console.log('Daily snapshot scheduler started');
}

app.get('/api/deposits', async (req, res) => {
  try {
    const { user, vault_id, chain } = req.query;
    const filter = {};
    if (user) filter.user_address = user;
    if (vault_id) filter.vault_id = vault_id;
    if (chain) filter.chain = chain;
    
    const docs = await colDeposits.find(filter).sort({ created_at: -1 }).limit(100).toArray();

    res.json(
      docs.map((d) => ({
        id: d._id?.toString(),
        user: d.user_address,
        vault: d.vault_address,
        vault_id: d.vault_id,
        vault_name: d.vault_name,
        chain: d.chain,
        asset_symbol: d.asset_symbol,
        asset_decimals: d.asset_decimals,
        amount: d.amount,
        status: d.status,
        source: d.source || 'yieldo',
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
    const { vault_id, chain, combined } = req.query;
    
    let query = {};
    if (vault_id) query.vault_id = vault_id;
    if (chain) query.chain = chain;
    
    const docs = await colSnapshots.find(query).sort({ date: -1 }).limit(30).toArray();
    
    if (combined === 'true') {
      const byDate = {};
      for (const s of docs) {
        if (!byDate[s.date]) {
          byDate[s.date] = {
            date: s.date,
            total_assets: 0n,
            total_deposits: 0n,
            total_withdrawals: 0n,
            vaults: [],
          };
        }
        byDate[s.date].total_assets += BigInt(s.total_assets || '0');
        byDate[s.date].total_deposits += BigInt(s.total_deposits || '0');
        byDate[s.date].total_withdrawals += BigInt(s.total_withdrawals || '0');
        byDate[s.date].vaults.push({
          vault_id: s.vault_id,
          vault_name: s.vault_name,
          chain: s.chain,
          asset_symbol: s.asset_symbol,
        });
      }
      
      return res.json(
        Object.values(byDate).map((s) => ({
          date: s.date,
          total_assets: s.total_assets.toString(),
          total_deposits: s.total_deposits.toString(),
          total_withdrawals: s.total_withdrawals.toString(),
          aum: s.total_assets.toString(),
          totalDeposits: s.total_deposits.toString(),
          totalWithdrawals: s.total_withdrawals.toString(),
          vaults: s.vaults,
        }))
      );
    }
    
    res.json(
      docs.map((s) => ({
        date: s.date,
        vault_id: s.vault_id,
        vault_name: s.vault_name,
        chain: s.chain,
        asset_symbol: s.asset_symbol,
        total_assets: s.total_assets || '0',
        total_deposits: s.total_deposits || '0',
        total_withdrawals: s.total_withdrawals || '0',
        aum: s.total_assets || '0',
        totalDeposits: s.total_deposits || '0',
        totalWithdrawals: s.total_withdrawals || '0',
        totalSupply: s.total_supply || '0',
        depositEpochId: s.deposit_epoch_id || 0,
        redeemEpochId: s.redeem_epoch_id || 0,
      }))
    );
  } catch (error) {
    console.error('Error fetching snapshots:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/intents', async (req, res) => {
  try {
    const { user, vault_id, chain } = req.query;
    const filter = {};
    if (user) filter.user_address = user;
    if (vault_id) filter.vault_id = vault_id;
    if (chain) filter.chain = chain;
    
    const docs = await colIntents.find(filter).sort({ created_at: -1 }).limit(100).toArray();
    res.json(
      docs.map((i) => ({
        id: i._id?.toString(),
        intentHash: i.intent_hash,
        user: i.user_address,
        vault: i.vault_address,
        vault_id: i.vault_id,
        chain: i.chain,
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
    const { user, vault_id, chain } = req.query;
    const filter = {};
    if (user) filter.user_address = user;
    if (vault_id) filter.vault_id = vault_id;
    if (chain) filter.chain = chain;
    
    const docs = await colWithdrawals.find(filter).sort({ created_at: -1 }).limit(100).toArray();
    res.json(
      docs.map((w) => ({
        id: w._id?.toString(),
        user: w.user_address,
        vault: w.vault_address,
        vault_id: w.vault_id,
        vault_name: w.vault_name,
        chain: w.chain,
        asset_symbol: w.asset_symbol,
        asset_decimals: w.asset_decimals,
        shares: w.shares,
        assets: w.assets,
        epochId: w.epoch_id ?? null,
        status: w.status,
        source: w.source || 'lagoon',
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

app.post('/api/deposits/mark-yieldo', async (req, res) => {
  try {
    const { txHash, userAddress } = req.body;
    
    if (!txHash) {
      return res.status(400).json({ error: 'txHash is required' });
    }

    console.log(`Marking deposit as Yieldo: ${txHash}`);

    const result = await colDeposits.updateOne(
      { transaction_hash: txHash },
      { $set: { source: 'yieldo' } }
    );

    if (result.matchedCount > 0) {
      console.log(`✅ Marked deposit as Yieldo: ${txHash}`);
      return res.json({ 
        success: true, 
        message: 'Deposit marked as from Yieldo',
        txHash,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount
      });
    }

    if (userAddress) {
      const markerId = `pending_yieldo_deposit_${txHash}`;
      await colMeta.updateOne(
        { _id: markerId },
        {
          $set: {
            transaction_hash: txHash,
            user_address: userAddress,
            created_at: new Date(),
          },
        },
        { upsert: true }
      );
      await colMeta.updateOne(
        { _id: txHash },
        {
          $set: {
            transaction_hash: txHash,
            user_address: userAddress,
            created_at: new Date(),
            is_yieldo_deposit: true,
          },
        },
        { upsert: true }
      );
      
      console.log(`📝 Stored pending marker for deposit: ${txHash} (will be marked when indexed)`);
      const existingResult = await colDeposits.updateOne(
        { transaction_hash: txHash },
        { $set: { source: 'yieldo' } }
      );
      
      if (existingResult.matchedCount > 0) {
        console.log(`✅ Also updated existing deposit record for ${txHash}`);
        return res.json({ 
          success: true, 
          message: 'Deposit found and marked as Yieldo. Marker also stored for future indexing.',
          txHash,
          matchedCount: existingResult.matchedCount,
          modifiedCount: existingResult.modifiedCount
        });
      }
      
      return res.json({ 
        success: true, 
        message: 'Deposit not indexed yet, but marker stored. It will be marked as Yieldo when indexed.',
        txHash,
        pending: true
      });
    }
    
    console.log(`⚠️  Deposit not found for txHash: ${txHash}`);
    return res.status(404).json({ 
      error: 'Deposit not found. It may not have been indexed yet. Please wait a few seconds and try again.',
      txHash 
    });
  } catch (error) {
    console.error('Error marking deposit:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/deposits/mark-yieldo-and-backfill', async (req, res) => {
  try {
    const { txHash, userAddress, blockNumber } = req.body;
    
    if (!txHash) {
      return res.status(400).json({ error: 'txHash is required' });
    }

    const markResult = await colDeposits.updateOne(
      { transaction_hash: txHash },
      { $set: { source: 'yieldo' } }
    );

    if (userAddress) {
      const markerId = `pending_yieldo_deposit_${txHash}`;
      await colMeta.updateOne(
        { _id: markerId },
        {
          $set: {
            transaction_hash: txHash,
            user_address: userAddress,
            created_at: new Date(),
          },
        },
        { upsert: true }
      );
      await colMeta.updateOne(
        { _id: txHash },
        {
          $set: {
            transaction_hash: txHash,
            user_address: userAddress,
            created_at: new Date(),
            is_yieldo_deposit: true,
          },
        },
        { upsert: true }
      );
    }

    if (blockNumber) {
      const block = BigInt(blockNumber);
      const existingDeposit = await colDeposits.findOne({ transaction_hash: txHash });
      let vaultConfig = null;
      if (existingDeposit && existingDeposit.vault_id) {
        vaultConfig = getVaultById(existingDeposit.vault_id);
      } else {
        vaultConfig = VAULTS_CONFIG.find(v => v.chain === 'ethereum');
      }
      
      if (vaultConfig) {
        console.log(`Backfilling block ${block} for vault ${vaultConfig.id}`);
        const client = getClientForVault(vaultConfig);
        if (vaultConfig.depositRouter) {
          await indexDepositRouterEventsForVault(vaultConfig, client, colIntents, colDeposits, block, block);
        }
        await indexVaultEventsForVault(vaultConfig, client, colDeposits, colWithdrawals, colPendingYieldoWithdrawals, colIntents, colMeta, block, block);
        console.log(`✅ Completed backfill for block ${block}`);
      } else {
        console.warn(`Could not find vault config for backfilling block ${block}`);
      }
    }

    return res.json({ 
      success: true, 
      message: 'Deposit marked as Yieldo' + (blockNumber ? ` and block ${blockNumber} backfilled` : ''),
      txHash,
      matchedCount: markResult.matchedCount,
      modifiedCount: markResult.modifiedCount,
      blockBackfilled: blockNumber || null
    });
  } catch (error) {
    console.error('Error marking deposit and backfilling:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/withdrawals/mark-yieldo', async (req, res) => {
  try {
    const { txHash, userAddress } = req.body;
    
    if (!txHash) {
      return res.status(400).json({ error: 'txHash is required' });
    }

    console.log(`Marking withdrawal as Yieldo: ${txHash}`);

    const result = await colWithdrawals.updateOne(
      { transaction_hash: txHash },
      { $set: { source: 'yieldo' } }
    );

    if (result.matchedCount > 0) {
      await colPendingYieldoWithdrawals.deleteOne({ transaction_hash: txHash });
      console.log(`✅ Marked withdrawal as Yieldo: ${txHash}`);
      return res.json({ 
        success: true, 
        message: 'Withdrawal marked as from Yieldo',
        txHash,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount
      });
    }

    if (userAddress) {
      await colPendingYieldoWithdrawals.updateOne(
        { transaction_hash: txHash },
        {
          $setOnInsert: {
            transaction_hash: txHash,
            user_address: userAddress,
            created_at: new Date(),
          },
        },
        { upsert: true }
      );
      console.log(`📝 Stored pending marker for withdrawal: ${txHash} (will be marked when indexed)`);
      return res.json({ 
        success: true, 
        message: 'Withdrawal not indexed yet, but marker stored. It will be marked as Yieldo when indexed.',
        txHash,
        pending: true
      });
    }
    
    console.log(`⚠️  Withdrawal not found for txHash: ${txHash}`);
    return res.status(404).json({ 
      error: 'Withdrawal not found. It may not have been indexed yet. Please wait a few seconds and try again.',
      txHash 
    });
  } catch (error) {
    console.error('Error marking withdrawal:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/aum', async (req, res) => {
  try {
    const { user, vault_id, chain, combined } = req.query;
    if (!user) {
      return res.status(400).json({ error: 'user query parameter is required' });
    }

    const depositFilter = {
      user_address: user,
      $or: [
        { source: 'yieldo' },
        { intent_hash: { $exists: true, $ne: null } }
      ],
      status: { $in: ['executed', 'settled', 'requested'] }
    };
    if (vault_id) {
      depositFilter.vault_id = vault_id;
    }
    if (chain) {
      depositFilter.chain = chain;
    }

    const withdrawalFilter = {
      user_address: user,
      source: 'yieldo',
      status: { $in: ['pending', 'settled'] }
    };
    if (vault_id) {
      withdrawalFilter.vault_id = vault_id;
    }
    if (chain) {
      withdrawalFilter.chain = chain;
    }

    const allDepositsFilter = combined === 'true' 
      ? {
          user_address: user,
          $or: [
            { source: 'yieldo' },
            { intent_hash: { $exists: true, $ne: null } }
          ],
          status: { $in: ['executed', 'settled', 'requested'] }
        }
      : depositFilter;
    
    const allWithdrawalsFilter = combined === 'true'
      ? {
          user_address: user,
          source: 'yieldo',
          status: { $in: ['pending', 'settled'] }
        }
      : withdrawalFilter;
    
    const yieldoDeposits = await colDeposits.find(allDepositsFilter).toArray();
    const yieldoWithdrawals = await colWithdrawals.find(allWithdrawalsFilter).toArray();
    const vaultsToProcess = combined === 'true' 
      ? VAULTS_CONFIG 
      : vault_id ? [{ id: vault_id, chain: chain }] : VAULTS_CONFIG;
    
    let totalAUM = 0n;
    let totalDepositsYieldo = 0n;
    let totalWithdrawalsYieldo = 0n;
    const vaultBreakdown = [];
    const erc4626Abi = [
      {
        inputs: [{ name: 'account', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
      },
    ];

    for (const vaultInfo of vaultsToProcess) {
      const vaultConfig = vaultInfo.id ? getVaultById(vaultInfo.id) : vaultInfo;
      if (!vaultConfig) continue;
      const vaultDeposits = yieldoDeposits.filter(d => 
        d.vault_id && d.chain && d.vault_id === vaultConfig.id && d.chain === vaultConfig.chain
      );
      const vaultWithdrawals = yieldoWithdrawals.filter(w => 
        w.vault_id && w.chain && w.vault_id === vaultConfig.id && w.chain === vaultConfig.chain
      );
      
      const vaultDepositsAmount = vaultDeposits.reduce(
        (acc, d) => acc + BigInt(d.amount || '0'),
        0n
      );
      
      const client = getClientForVault(vaultConfig);
      let vault = null;
      try {
        vault = await Vault.fetch(vaultConfig.address, client);
      } catch (error) {
        console.error(`Error fetching vault ${vaultConfig.id}:`, error);
        continue;
      }

      let vaultWithdrawalsAmount = 0n;
      for (const w of vaultWithdrawals) {
        if (w.assets) {
          vaultWithdrawalsAmount += BigInt(w.assets);
        } else if (w.shares && vault && vault.totalSupply > 0n) {
          try {
            const sharesBigInt = BigInt(w.shares);
            const estimatedAssets = vault.convertToAssets(sharesBigInt);
            vaultWithdrawalsAmount += estimatedAssets;
          } catch (error) {
            console.error(`Error converting shares for withdrawal ${w._id}:`, error);
          }
        }
      }

      let vaultUserBalance = 0n;
      try {
        const userShares = await client.readContract({
          address: vaultConfig.address,
          abi: erc4626Abi,
          functionName: 'balanceOf',
          args: [user],
        });
        
        if (vault.totalSupply > 0n && userShares > 0n) {
          vaultUserBalance = vault.convertToAssets(userShares);
        }
      } catch (error) {
        console.error(`Error fetching user balance in vault ${vaultConfig.id}:`, error);
      }
      
      const theoreticalAUM = vaultDepositsAmount - vaultWithdrawalsAmount;
      const actualVaultAUM = theoreticalAUM > vaultUserBalance 
        ? vaultUserBalance 
        : theoreticalAUM;
      
      totalAUM += actualVaultAUM;
      totalDepositsYieldo += vaultDepositsAmount;
      totalWithdrawalsYieldo += vaultWithdrawalsAmount;
      
      vaultBreakdown.push({
        vault_id: vaultConfig.id,
        vault_name: vaultConfig.name,
        chain: vaultConfig.chain,
        asset_symbol: vaultConfig.asset.symbol,
        aum: actualVaultAUM.toString(),
        deposits: vaultDepositsAmount.toString(),
        withdrawals: vaultWithdrawalsAmount.toString(),
      });
    }

    res.json({
      user,
      totalDepositsYieldo: totalDepositsYieldo.toString(),
      totalWithdrawalsYieldo: totalWithdrawalsYieldo.toString(),
      aumFromYieldo: totalAUM.toString(),
      combined: combined === 'true',
      vaultBreakdown,
      breakdown: {
        deposits: yieldoDeposits.length,
        withdrawalsYieldo: yieldoWithdrawals.length,
      },
    });
  } catch (error) {
    console.error('Error calculating AUM:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  const blocks = {};
  for (const [chain, block] of Object.entries(lastProcessedBlocks)) {
    blocks[chain] = block?.toString();
  }
  res.json({ status: 'ok', lastProcessedBlocks: blocks });
});

app.get('/api/debug/tx', async (req, res) => {
  try {
    const { txHash, chain } = req.query;
    
    if (!txHash) {
      return res.status(400).json({ error: 'txHash query parameter is required' });
    }
    
    if (!chain) {
      return res.status(400).json({ error: 'chain query parameter is required (avalanche or ethereum)' });
    }

    const client = clients[chain];
    if (!client) {
      return res.status(400).json({ error: `Invalid chain: ${chain}` });
    }

    const receipt = await client.getTransactionReceipt({ hash: txHash });
    if (!receipt) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const allLogs = receipt.logs || [];
    const vaultConfig = VAULTS_CONFIG.find(v => 
      allLogs.some(log => log.address.toLowerCase() === v.address.toLowerCase())
    );
    
    if (!vaultConfig) {
      return res.json({
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        status: receipt.status,
        from: receipt.from,
        to: receipt.to,
        message: 'No known vault address found in transaction logs',
        totalLogs: allLogs.length,
      });
    }
    
    const vaultLogs = allLogs.filter(log => 
      log.address.toLowerCase() === vaultConfig.address.toLowerCase()
    );

    const decodedEvents = [];
    for (const log of vaultLogs) {
      try {
        try {
          const decoded = parseAbiItem('event RedeemRequested(address indexed user, uint256 indexed epochId, uint256 shares)');
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
      vaultAddress: vaultConfig?.address,
      vaultId: vaultConfig?.id,
      chain: chain,
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

app.get('/api/debug/events', async (req, res) => {
  try {
    const { fromBlock, toBlock } = req.query;
    
    if (!fromBlock || !toBlock) {
      return res.status(400).json({ error: 'fromBlock and toBlock query parameters are required' });
    }

    const from = BigInt(fromBlock);
    const to = BigInt(toBlock);

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

app.post('/api/backfill/block', async (req, res) => {
  try {
    const { blockNumber } = req.body;
    
    if (!blockNumber) {
      return res.status(400).json({ error: 'blockNumber is required' });
    }

    const block = BigInt(blockNumber);
    const { vault_id, chain } = req.body;
    
    console.log(`Manual backfill requested for block ${block}${vault_id ? ` (vault: ${vault_id})` : ''}`);
    
    try {
      if (vault_id && chain) {
        const vaultConfig = getVaultById(vault_id);
        if (!vaultConfig || vaultConfig.chain !== chain) {
          return res.status(400).json({ error: 'Invalid vault_id or chain' });
        }
        
        const client = getClientForVault(vaultConfig);
        if (vaultConfig.depositRouter) {
          await indexDepositRouterEventsForVault(vaultConfig, client, colIntents, colDeposits, block, block);
        }
        await indexVaultEventsForVault(vaultConfig, client, colDeposits, colWithdrawals, colPendingYieldoWithdrawals, colIntents, colMeta, block, block);
        
        res.json({ 
          success: true, 
          message: `Backfilled block ${block} for vault ${vault_id}`,
          blockNumber: block.toString(),
          vault_id: vault_id,
          chain: chain
        });
      } else {
        for (const vaultConfig of VAULTS_CONFIG) {
          const client = getClientForVault(vaultConfig);
          if (vaultConfig.depositRouter) {
            await indexDepositRouterEventsForVault(vaultConfig, client, colIntents, colDeposits, block, block);
          }
          await indexVaultEventsForVault(vaultConfig, client, colDeposits, colWithdrawals, colPendingYieldoWithdrawals, colIntents, colMeta, block, block);
        }
        
        res.json({ 
          success: true, 
          message: `Backfilled block ${block} for all vaults`,
          blockNumber: block.toString()
        });
      }
    } catch (backfillError) {
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

app.get('/api/backfill/block', async (req, res) => {
  try {
    const { blockNumber, vault_id, chain } = req.query;
    
    if (!blockNumber) {
      return res.status(400).json({ error: 'blockNumber query parameter is required' });
    }

    const block = BigInt(blockNumber);
    console.log(`Manual backfill requested for block ${block}${vault_id ? ` (vault: ${vault_id})` : ''}`);
    
    try {
      if (vault_id && chain) {
        const vaultConfig = getVaultById(vault_id);
        if (!vaultConfig || vaultConfig.chain !== chain) {
          return res.status(400).json({ error: 'Invalid vault_id or chain' });
        }
        
        const client = getClientForVault(vaultConfig);
        if (vaultConfig.depositRouter) {
          await indexDepositRouterEventsForVault(vaultConfig, client, colIntents, colDeposits, block, block);
        }
        await indexVaultEventsForVault(vaultConfig, client, colDeposits, colWithdrawals, colPendingYieldoWithdrawals, colIntents, colMeta, block, block);
        
        res.json({ 
          success: true, 
          message: `Backfilled block ${block} for vault ${vault_id}`,
          blockNumber: block.toString(),
          vault_id: vault_id,
          chain: chain
        });
      } else {
        for (const vaultConfig of VAULTS_CONFIG) {
          const client = getClientForVault(vaultConfig);
          if (vaultConfig.depositRouter) {
            await indexDepositRouterEventsForVault(vaultConfig, client, colIntents, colDeposits, block, block);
          }
          await indexVaultEventsForVault(vaultConfig, client, colDeposits, colWithdrawals, colPendingYieldoWithdrawals, colIntents, colMeta, block, block);
        }
        
        res.json({ 
          success: true, 
          message: `Backfilled block ${block} for all vaults`,
          blockNumber: block.toString()
        });
      }
    } catch (backfillError) {
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

app.delete('/api/snapshots/:date', async (req, res) => {
  try {
    const { date } = req.params;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const result = await colSnapshots.deleteOne({
      date: date
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: `Snapshot for ${date} not found` });
    }

    res.json({
      success: true,
      message: `Deleted snapshot for ${date}`,
      date: date
    });
  } catch (error) {
    console.error('Error deleting snapshot:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/snapshots/recalculate-aum', async (req, res) => {
  try {
    let totalYieldoAUM = 0n;
    const vaultResults = [];

    for (const vaultConfig of VAULTS_CONFIG) {
      try {
        const client = getClientForVault(vaultConfig);
        const vault = await Vault.fetch(vaultConfig.address, client);
        if (!vault) {
          console.error(`[${vaultConfig.id}] Failed to fetch vault`);
          continue;
        }

        const yieldoUsers = await colDeposits.distinct('user_address', {
          vault_id: vaultConfig.id,
          chain: vaultConfig.chain,
          $or: [
            { source: 'yieldo' },
            { intent_hash: { $exists: true, $ne: null } }
          ],
          status: { $in: ['executed', 'settled', 'requested'] }
        });

        let vaultYieldoAUM = 0n;
        const erc4626Abi = [
          {
            inputs: [{ name: 'account', type: 'address' }],
            name: 'balanceOf',
            outputs: [{ name: '', type: 'uint256' }],
            stateMutability: 'view',
            type: 'function',
          },
        ];

        console.log(`[${vaultConfig.id}] Recalculating Yieldo AUM from ${yieldoUsers.length} users...`);
        for (const user of yieldoUsers) {
          try {
            const userShares = await client.readContract({
              address: vaultConfig.address,
              abi: erc4626Abi,
              functionName: 'balanceOf',
              args: [user],
            });
            
            if (vault.totalSupply > 0n && userShares > 0n) {
              const userAssets = vault.convertToAssets(userShares);
              vaultYieldoAUM += userAssets;
            }
          } catch (error) {
            console.error(`[${vaultConfig.id}] Error fetching balance for user ${user}:`, error);
          }
        }
        
        totalYieldoAUM += vaultYieldoAUM;
        vaultResults.push({
          vault_id: vaultConfig.id,
          vault_name: vaultConfig.name,
          chain: vaultConfig.chain,
          aum: vaultYieldoAUM.toString(),
        });
      } catch (error) {
        console.error(`[${vaultConfig.id}] Error processing vault:`, error);
      }
    }

    const today = new Date();
    const todayKey = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0))
      .toISOString().slice(0, 10);

    let totalUpdated = 0;
    for (const vaultConfig of VAULTS_CONFIG) {
      const vaultResult = vaultResults.find(r => r.vault_id === vaultConfig.id);
      if (!vaultResult) continue;
      
      const result = await colSnapshots.updateMany(
        { 
          vault_id: vaultConfig.id,
          chain: vaultConfig.chain,
          date: { $ne: todayKey }
        },
        {
          $set: {
            total_assets: vaultResult.aum,
            updated_at: new Date(),
          },
        }
      );
      totalUpdated += result.modifiedCount;
    }

    const aumFormatted = (totalYieldoAUM / BigInt(1e6)).toString();
    console.log(`Recalculated AUM for ${totalUpdated} past snapshots (excluding today ${todayKey}): ${aumFormatted} USDC`);

    res.json({
      success: true,
      message: `Recalculated AUM for ${totalUpdated} past snapshots (excluding today)`,
      totalYieldoAUM: totalYieldoAUM.toString(),
      totalYieldoAUMFormatted: aumFormatted,
      snapshotsUpdated: totalUpdated,
      todayExcluded: todayKey,
      vaultBreakdown: vaultResults,
    });
  } catch (error) {
    console.error('Error recalculating snapshots AUM:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Indexer API running on port ${PORT}`);
  startIndexing();
});

