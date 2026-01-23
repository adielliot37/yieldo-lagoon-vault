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

  await Promise.all([
    colIntents.createIndex({ intent_hash: 1 }, { unique: true }),
    colIntents.createIndex({ user_address: 1, created_at: -1 }),
    colDeposits.createIndex({ user_address: 1, created_at: -1 }),
    colDeposits.createIndex({ transaction_hash: 1 }),
    colWithdrawals.createIndex({ user_address: 1, created_at: -1 }),
    colSnapshots.createIndex({ date: 1, vault_address: 1 }, { unique: true }),
  ]);

  console.log('MongoDB initialized');
}

async function indexDepositRouterEvents(fromBlock, toBlock) {
  if (!DEPOSIT_ROUTER_ADDRESS) return;

  try {
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
    console.error('Error indexing DepositRouter events:', error);
  }
}

async function indexVaultEvents(fromBlock, toBlock) {
  if (!VAULT_ADDRESS) return;

  try {
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

    const redeemRequestedLogs = await client.getLogs({
      address: VAULT_ADDRESS,
      event: parseAbiItem('event RedeemRequested(address indexed user, uint256 indexed epochId, uint256 shares)'),
      fromBlock,
      toBlock,
    });

    for (const log of redeemRequestedLogs) {
      const { user, epochId, shares } = log.args;

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
    }

    const redeemSettledLogs = await client.getLogs({
      address: VAULT_ADDRESS,
      event: parseAbiItem('event RedeemSettled(address indexed user, uint256 indexed epochId, uint256 assets)'),
      fromBlock,
      toBlock,
    });

    for (const log of redeemSettledLogs) {
      const { user, epochId, assets } = log.args;

      await colWithdrawals.updateOne(
        { user_address: user, vault_address: VAULT_ADDRESS, epoch_id: Number(epochId) },
        { $set: { assets: assets.toString(), status: 'settled' } }
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
    console.error('Error indexing vault events:', error);
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

  // Index every 10 seconds
  setInterval(async () => {
    try {
      const currentBlock = await client.getBlockNumber();
      const toBlock = currentBlock;
      const fromBlock = lastProcessedBlock + 1n;

      if (fromBlock <= toBlock) {
        console.log(`Indexing blocks ${fromBlock} to ${toBlock}`);
        await indexDepositRouterEvents(fromBlock, toBlock);
        await indexVaultEvents(fromBlock, toBlock);
        lastProcessedBlock = toBlock;

        await colMeta.updateOne(
          { _id: 'lastProcessedBlock' },
          { $set: { value: lastProcessedBlock.toString(), updated_at: new Date() } },
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', lastBlock: lastProcessedBlock?.toString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Indexer API running on port ${PORT}`);
  startIndexing();
});

