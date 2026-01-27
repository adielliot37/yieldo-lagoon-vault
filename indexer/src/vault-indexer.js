import { parseAbiItem } from 'viem';
import { Vault } from '@lagoon-protocol/v0-viem';

export async function indexDepositRouterEventsForVault(
  vaultConfig,
  client,
  colIntents,
  colDeposits,
  fromBlock,
  toBlock
) {
  if (!vaultConfig.depositRouter) return;

  try {
    if (fromBlock > toBlock) {
      console.warn(`[${vaultConfig.id}] Invalid block range: fromBlock ${fromBlock} > toBlock ${toBlock}`);
      return;
    }

    const intentCreatedLogs = await client.getLogs({
      address: vaultConfig.depositRouter,
      event: parseAbiItem('event DepositIntentCreated(bytes32 indexed intentHash, address indexed user, address indexed vault, address asset, uint256 amount, uint256 nonce, uint256 deadline)'),
      fromBlock,
      toBlock,
    });

    for (const log of intentCreatedLogs) {
      const { intentHash, user, vault, asset, amount, nonce, deadline } = log.args;

      if (vault.toLowerCase() !== vaultConfig.address.toLowerCase()) continue;

      await colIntents.updateOne(
        { intent_hash: intentHash, chain: vaultConfig.chain, vault_id: vaultConfig.id },
        {
          $setOnInsert: {
            intent_hash: intentHash,
            user_address: user,
            vault_address: vault,
            vault_id: vaultConfig.id,
            chain: vaultConfig.chain,
            asset_address: asset,
            asset_symbol: vaultConfig.asset.symbol,
            asset_decimals: vaultConfig.asset.decimals,
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
      address: vaultConfig.depositRouter,
      event: parseAbiItem('event DepositExecuted(bytes32 indexed intentHash, address indexed user, address indexed vault, uint256 amount)'),
      fromBlock,
      toBlock,
    });

    for (const log of depositExecutedLogs) {
      const { intentHash, user, vault, amount } = log.args;

      if (vault.toLowerCase() !== vaultConfig.address.toLowerCase()) continue;

      await colIntents.updateOne(
        { intent_hash: intentHash, chain: vaultConfig.chain, vault_id: vaultConfig.id },
        { $set: { status: 'executed', executed_at: new Date() } }
      );

      await colDeposits.updateOne(
        { transaction_hash: log.transactionHash, chain: vaultConfig.chain, vault_id: vaultConfig.id },
        {
          $set: {
            intent_hash: intentHash,
            user_address: user,
            vault_address: vault,
            vault_id: vaultConfig.id,
            chain: vaultConfig.chain,
            vault_name: vaultConfig.name,
            asset_address: vaultConfig.asset.address,
            asset_symbol: vaultConfig.asset.symbol,
            asset_decimals: vaultConfig.asset.decimals,
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
      
      console.log(`[${vaultConfig.id}] Deposit executed: ${intentHash} for user ${user}, amount: ${amount.toString()}, tx: ${log.transactionHash}`);
    }

    const depositRequestSubmittedLogs = await client.getLogs({
      address: vaultConfig.depositRouter,
      event: parseAbiItem('event DepositRequestSubmitted(bytes32 indexed intentHash, address indexed user, address indexed vault, uint256 amount, uint256 requestId)'),
      fromBlock,
      toBlock,
    });

    for (const log of depositRequestSubmittedLogs) {
      const { intentHash, user, vault, amount, requestId } = log.args;

      if (vault.toLowerCase() !== vaultConfig.address.toLowerCase()) continue;

      await colIntents.updateOne(
        { intent_hash: intentHash, chain: vaultConfig.chain, vault_id: vaultConfig.id },
        { $set: { status: 'executed', executed_at: new Date() } }
      );

      await colDeposits.updateOne(
        { transaction_hash: log.transactionHash, chain: vaultConfig.chain, vault_id: vaultConfig.id },
        {
          $set: {
            intent_hash: intentHash,
            user_address: user,
            vault_address: vault,
            vault_id: vaultConfig.id,
            chain: vaultConfig.chain,
            vault_name: vaultConfig.name,
            asset_address: vaultConfig.asset.address,
            asset_symbol: vaultConfig.asset.symbol,
            asset_decimals: vaultConfig.asset.decimals,
            amount: amount.toString(),
            requested_amount: amount.toString(),
            epoch_id: Number(requestId),
            status: 'requested',
            block_number: log.blockNumber.toString(),
            transaction_hash: log.transactionHash,
            executed_at: new Date(),
            source: 'yieldo',
          },
          $setOnInsert: {
            shares: null,
            created_at: new Date(),
          },
        },
        { upsert: true }
      );

      console.log(`[${vaultConfig.id}] DepositRequestSubmitted indexed: requestId ${requestId} for user ${user}, amount: ${amount.toString()}, tx: ${log.transactionHash}`);
    }
  } catch (error) {
    if (error.message && (error.message.includes('after last accepted block') || error.message.includes('requested from block'))) {
      const finalityError = new Error(`[${vaultConfig.id}] Block range ${fromBlock}-${toBlock} not yet finalized`);
      finalityError.name = 'BlockNotFinalizedError';
      throw finalityError;
    }
    console.error(`[${vaultConfig.id}] Error indexing DepositRouter events:`, error);
    throw error;
  }
}

export async function indexVaultEventsForVault(
  vaultConfig,
  client,
  colDeposits,
  colWithdrawals,
  colPendingYieldoWithdrawals,
  colIntents,
  colMeta,
  fromBlock,
  toBlock
) {
  try {
    if (fromBlock > toBlock) {
      console.warn(`[${vaultConfig.id}] Invalid block range: fromBlock ${fromBlock} > toBlock ${toBlock}`);
      return;
    }

    let depositRequestedLogs = [];
    try {
      depositRequestedLogs = await client.getLogs({
        address: vaultConfig.address,
        event: parseAbiItem('event DepositRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 assets)'),
        fromBlock,
        toBlock,
      });
    } catch (e) {
      console.log(`[${vaultConfig.id}] ERC-7540 DepositRequest event not found, trying Lagoon-specific format`);
    }
    
    let lagoonDepositRequestedLogs = [];
    if (depositRequestedLogs.length === 0) {
      try {
        lagoonDepositRequestedLogs = await client.getLogs({
          address: vaultConfig.address,
          event: parseAbiItem('event DepositRequested(address indexed user, uint256 indexed epochId, uint256 amount)'),
          fromBlock,
          toBlock,
        });
      } catch (e) {
        console.log(`[${vaultConfig.id}] Lagoon DepositRequested event not found`);
      }
    }

    const routerLower = vaultConfig.depositRouter ? String(vaultConfig.depositRouter).toLowerCase() : null;

    for (const log of depositRequestedLogs) {
      const { controller, owner, requestId, sender, assets } = log.args;
      const senderLower = String(sender).toLowerCase();
      const ownerLower = String(owner).toLowerCase();

      const fromRouter = routerLower && (senderLower === routerLower || ownerLower === routerLower);
      if (fromRouter) {
        const existingByTx = await colDeposits.findOne({
          transaction_hash: log.transactionHash,
          chain: vaultConfig.chain,
        });
        await colDeposits.updateOne(
          {
            transaction_hash: log.transactionHash,
            chain: vaultConfig.chain,
            vault_id: vaultConfig.id,
          },
          {
            $set: {
              user_address: controller,
              vault_address: vaultConfig.address,
              epoch_id: Number(requestId),
              status: 'requested',
              amount: assets.toString(),
              requested_amount: assets.toString(),
              source: 'yieldo',
              vault_id: vaultConfig.id,
              vault_name: vaultConfig.name,
              chain: vaultConfig.chain,
              asset_address: vaultConfig.asset.address,
              asset_symbol: vaultConfig.asset.symbol,
              asset_decimals: vaultConfig.asset.decimals,
              block_number: log.blockNumber.toString(),
              transaction_hash: log.transactionHash,
              created_at: existingByTx?.created_at || new Date(),
            },
            $setOnInsert: {
              shares: null,
              executed_at: null,
              settled_at: null,
            },
          },
          { upsert: true }
        );
        console.log(`[${vaultConfig.id}] Yieldo DepositRequest indexed (router caller): requestId ${requestId} for user ${controller}, amount: ${assets.toString()}, tx: ${log.transactionHash}`);
        continue;
      }

      const existingDeposit = await colDeposits.findOne({
        $or: [
          { user_address: owner, vault_address: vaultConfig.address, chain: vaultConfig.chain, status: 'pending' },
          { user_address: controller, vault_address: vaultConfig.address, chain: vaultConfig.chain, status: 'pending' },
          { transaction_hash: log.transactionHash, chain: vaultConfig.chain },
        ],
      }, { sort: { created_at: -1 } });

      let isYieldoDeposit = false;
      let source = 'lagoon';
      let userForDeposit = owner;

      if (existingDeposit) {
        if (existingDeposit.source === 'yieldo' || existingDeposit.intent_hash) {
          isYieldoDeposit = true;
          source = 'yieldo';
          userForDeposit = existingDeposit.user_address;
        }
      } else {
        const matchingIntent = await colIntents.findOne({
          $or: [
            { user_address: owner, vault_address: vaultConfig.address, chain: vaultConfig.chain, status: 'pending' },
            { user_address: controller, vault_address: vaultConfig.address, chain: vaultConfig.chain, status: 'pending' },
          ],
        }, { sort: { created_at: -1 } });

        if (matchingIntent) {
          isYieldoDeposit = true;
          source = 'yieldo';
          userForDeposit = matchingIntent.user_address;
        } else {
          const markerId = `pending_yieldo_deposit_${log.transactionHash}`;
          const pendingMarker = await colMeta.findOne({
            $or: [
              { _id: markerId },
              { _id: log.transactionHash },
              { transaction_hash: log.transactionHash },
            ],
          });

          if (pendingMarker) {
            console.log(`[${vaultConfig.id}] Found pending Yieldo marker for tx ${log.transactionHash}`);
            isYieldoDeposit = true;
            source = 'yieldo';
            userForDeposit = owner;
            await colMeta.deleteOne({ _id: markerId });
            await colMeta.deleteOne({ _id: log.transactionHash });
            await colMeta.deleteOne({ transaction_hash: log.transactionHash });
          } else {
            const existingYieldoDeposit = await colDeposits.findOne({
              transaction_hash: log.transactionHash,
              source: 'yieldo',
            });
            if (existingYieldoDeposit) {
              console.log(`[${vaultConfig.id}] Found existing Yieldo deposit for tx ${log.transactionHash}`);
              isYieldoDeposit = true;
              source = 'yieldo';
              userForDeposit = existingYieldoDeposit.user_address;
            } else {
              const delayedMarker = await colMeta.findOne({
                $or: [
                  { _id: `pending_yieldo_deposit_${log.transactionHash}` },
                  { _id: log.transactionHash },
                  { transaction_hash: log.transactionHash },
                ],
              });
              if (delayedMarker) {
                console.log(`[${vaultConfig.id}] Found delayed Yieldo marker for tx ${log.transactionHash}`);
                isYieldoDeposit = true;
                source = 'yieldo';
                userForDeposit = owner;
                await colMeta.deleteOne({ _id: `pending_yieldo_deposit_${log.transactionHash}` });
                await colMeta.deleteOne({ _id: log.transactionHash });
              }
            }
          }
        }
      }

      if (!isYieldoDeposit) {
        console.log(`[${vaultConfig.id}] Skipping non-Yieldo DepositRequest: requestId ${requestId} for user ${owner}, tx: ${log.transactionHash}`);
        continue;
      }

      await colDeposits.updateOne(
        {
          transaction_hash: log.transactionHash,
          chain: vaultConfig.chain,
          vault_id: vaultConfig.id,
        },
        {
          $set: {
            user_address: userForDeposit,
            vault_address: vaultConfig.address,
            epoch_id: Number(requestId),
            status: 'requested',
            amount: assets.toString(),
            requested_amount: assets.toString(),
            source: source,
            vault_id: vaultConfig.id,
            vault_name: vaultConfig.name,
            chain: vaultConfig.chain,
            asset_address: vaultConfig.asset.address,
            asset_symbol: vaultConfig.asset.symbol,
            asset_decimals: vaultConfig.asset.decimals,
            block_number: log.blockNumber.toString(),
            transaction_hash: log.transactionHash,
            created_at: existingDeposit?.created_at || new Date(),
          },
          $setOnInsert: {
            shares: null,
            executed_at: null,
            settled_at: null,
          },
        },
        { upsert: true }
      );

      console.log(`[${vaultConfig.id}] Yieldo DepositRequest indexed: requestId ${requestId} for user ${userForDeposit}, amount: ${assets.toString()}, tx: ${log.transactionHash}`);
    }
    
    for (const log of lagoonDepositRequestedLogs) {
      const { user, epochId, amount } = log.args;
      const existingDeposit = await colDeposits.findOne(
        { user_address: user, vault_address: vaultConfig.address, chain: vaultConfig.chain, status: 'pending' },
        { sort: { created_at: -1 } }
      );
      
      let isYieldoDeposit = false;
      let source = 'lagoon';
      
      if (existingDeposit) {
        if (existingDeposit.source === 'yieldo' || existingDeposit.intent_hash) {
          isYieldoDeposit = true;
          source = 'yieldo';
        }
      } else {
        const matchingIntent = await colIntents.findOne({
          user_address: user,
          vault_address: vaultConfig.address,
          chain: vaultConfig.chain,
          status: 'pending'
        }, { sort: { created_at: -1 } });
        
        if (matchingIntent) {
          isYieldoDeposit = true;
          source = 'yieldo';
        }
      }
      
      if (!isYieldoDeposit) {
        console.log(`[${vaultConfig.id}] Skipping non-Yieldo DepositRequested: epochId ${epochId} for user ${user}`);
        continue;
      }
      
      await colDeposits.updateOne(
        { user_address: user, vault_address: vaultConfig.address, chain: vaultConfig.chain, status: 'pending' },
        { 
          $set: { 
            epoch_id: Number(epochId), 
            status: 'requested', 
            requested_amount: amount.toString(),
            source: source,
            vault_id: vaultConfig.id,
            vault_name: vaultConfig.name,
            chain: vaultConfig.chain,
            asset_symbol: vaultConfig.asset.symbol,
            asset_decimals: vaultConfig.asset.decimals,
          } 
        },
        { sort: { created_at: -1 } }
      );
      
      console.log(`[${vaultConfig.id}] Yieldo DepositRequested indexed: epochId ${epochId} for user ${user}, amount: ${amount.toString()}`);
    }

    const depositLogs = await client.getLogs({
      address: vaultConfig.address,
      event: parseAbiItem('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)'),
      fromBlock,
      toBlock,
    });

    for (const log of depositLogs) {
      const { sender, owner, assets, shares } = log.args;
      const senderLower = String(sender).toLowerCase();
      const ownerLower = String(owner).toLowerCase();

      const fromRouter = routerLower && senderLower === routerLower;
      const existingDeposit = await colDeposits.findOne({
        $or: [
          { transaction_hash: log.transactionHash, chain: vaultConfig.chain },
          { user_address: owner, vault_address: vaultConfig.address, chain: vaultConfig.chain, status: 'pending' },
        ],
      }, { sort: { created_at: -1 } });

      let isYieldoDeposit = false;
      let source = 'lagoon';
      let userForDeposit = owner;
      let matchedIntentHash = null;

      if (existingDeposit) {
        if (existingDeposit.source === 'yieldo' || existingDeposit.intent_hash) {
          isYieldoDeposit = true;
          source = 'yieldo';
          userForDeposit = existingDeposit.user_address;
          matchedIntentHash = existingDeposit.intent_hash;
        }
      } else if (fromRouter) {
        isYieldoDeposit = true;
        source = 'yieldo';
        userForDeposit = owner;
      } else {
        const matchingIntent = await colIntents.findOne({
          $or: [
            { user_address: owner, vault_address: vaultConfig.address, chain: vaultConfig.chain, status: 'pending' },
            { user_address: sender, vault_address: vaultConfig.address, chain: vaultConfig.chain, status: 'pending' },
          ],
        }, { sort: { created_at: -1 } });

        if (matchingIntent) {
          isYieldoDeposit = true;
          source = 'yieldo';
          userForDeposit = matchingIntent.user_address;
          matchedIntentHash = matchingIntent.intent_hash;
        } else {
          const markerId = `pending_yieldo_deposit_${log.transactionHash}`;
          const pendingMarker = await colMeta.findOne({
            $or: [
              { _id: markerId },
              { _id: log.transactionHash },
              { transaction_hash: log.transactionHash },
            ],
          });
          if (pendingMarker) {
            isYieldoDeposit = true;
            source = 'yieldo';
            userForDeposit = owner;
            await colMeta.deleteOne({ _id: markerId }).catch(() => {});
            await colMeta.deleteOne({ _id: log.transactionHash }).catch(() => {});
            await colMeta.deleteOne({ transaction_hash: log.transactionHash }).catch(() => {});
          }
        }
      }

      if (!isYieldoDeposit) {
        continue;
      }

      await colDeposits.updateOne(
        {
          transaction_hash: log.transactionHash,
          chain: vaultConfig.chain,
          vault_id: vaultConfig.id,
        },
        {
          $set: {
            user_address: userForDeposit,
            vault_address: vaultConfig.address,
            amount: assets.toString(),
            shares: shares.toString(),
            status: 'executed',
            source: source,
            vault_id: vaultConfig.id,
            vault_name: vaultConfig.name,
            chain: vaultConfig.chain,
            asset_address: vaultConfig.asset.address,
            asset_symbol: vaultConfig.asset.symbol,
            asset_decimals: vaultConfig.asset.decimals,
            block_number: log.blockNumber.toString(),
            transaction_hash: log.transactionHash,
            executed_at: existingDeposit?.executed_at || new Date(),
            created_at: existingDeposit?.created_at || new Date(),
          },
          $setOnInsert: {
            epoch_id: null,
            requested_amount: null,
            settled_at: null,
            intent_hash: matchedIntentHash ?? existingDeposit?.intent_hash,
          },
        },
        { upsert: true }
      );

      if (fromRouter && !existingDeposit) {
        console.log(`[${vaultConfig.id}] Yieldo Deposit indexed (router caller): user ${userForDeposit}, assets: ${assets.toString()}, shares: ${shares.toString()}, tx: ${log.transactionHash}`);
      } else if (existingDeposit) {
        console.log(`[${vaultConfig.id}] Deposit shares updated: ${shares.toString()}, tx: ${log.transactionHash}`);
      } else {
        console.log(`[${vaultConfig.id}] Yieldo Deposit indexed (intent match): user ${userForDeposit}, assets: ${assets.toString()}, shares: ${shares.toString()}, tx: ${log.transactionHash}`);
      }
    }

    const depositSettledLogs = await client.getLogs({
      address: vaultConfig.address,
      event: parseAbiItem('event DepositSettled(address indexed user, uint256 indexed epochId, uint256 shares)'),
      fromBlock,
      toBlock,
    });

    for (const log of depositSettledLogs) {
      const { user, epochId, shares } = log.args;
      const epochIdNum = Number(epochId);
      const sharesStr = shares.toString();

      let updated = await colDeposits.updateOne(
        { user_address: user, vault_address: vaultConfig.address, chain: vaultConfig.chain, epoch_id: epochIdNum },
        { 
          $set: { 
            shares: sharesStr, 
            status: 'settled',
            settled_at: new Date(),
            vault_id: vaultConfig.id,
            vault_name: vaultConfig.name,
            chain: vaultConfig.chain,
          } 
        }
      );

      if (updated.matchedCount === 0) {
        const byEpoch = await colDeposits.findOne(
          { vault_address: vaultConfig.address, chain: vaultConfig.chain, epoch_id: epochIdNum, status: 'requested' }
        );
        if (byEpoch) {
          await colDeposits.updateOne(
            { _id: byEpoch._id },
            { $set: { shares: sharesStr, status: 'settled', settled_at: new Date(), vault_id: vaultConfig.id, vault_name: vaultConfig.name, chain: vaultConfig.chain } }
          );
          console.log(`[${vaultConfig.id}] DepositSettled matched by epoch_id ${epochIdNum}, tx: ${log.transactionHash}`);
        }
      }
    }

    let redeemRequestedLogs = [];
    try {
      redeemRequestedLogs = await client.getLogs({
        address: vaultConfig.address,
        event: parseAbiItem('event RedeemRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares)'),
        fromBlock,
        toBlock,
      });
    } catch (e) {
      console.log(`[${vaultConfig.id}] Error querying ERC-7540 RedeemRequest: ${e.message}`);
    }
    
    let lagoonRedeemRequestedLogs = [];
    try {
      lagoonRedeemRequestedLogs = await client.getLogs({
        address: vaultConfig.address,
        event: parseAbiItem('event RedeemRequested(address indexed user, uint256 indexed epochId, uint256 shares)'),
        fromBlock,
        toBlock,
      });
    } catch (e) {
      console.log(`[${vaultConfig.id}] Error querying Lagoon RedeemRequested: ${e.message}`);
    }

    for (const log of redeemRequestedLogs) {
      const { controller, owner, requestId, sender, shares } = log.args;
      
      const pendingMarker = await colPendingYieldoWithdrawals.findOne({
        transaction_hash: log.transactionHash,
        chain: vaultConfig.chain
      });
      
      const source = pendingMarker ? 'yieldo' : 'lagoon';
      
      await colWithdrawals.updateOne(
        { transaction_hash: log.transactionHash, chain: vaultConfig.chain },
        {
          $setOnInsert: {
            user_address: owner,
            vault_address: vaultConfig.address,
            vault_id: vaultConfig.id,
            vault_name: vaultConfig.name,
            chain: vaultConfig.chain,
            asset_symbol: vaultConfig.asset.symbol,
            asset_decimals: vaultConfig.asset.decimals,
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
      
      if (pendingMarker) {
        await colPendingYieldoWithdrawals.deleteOne({ transaction_hash: log.transactionHash, chain: vaultConfig.chain });
      }
    }

    for (const log of lagoonRedeemRequestedLogs) {
      const { user, epochId, shares } = log.args;

      const pendingMarker = await colPendingYieldoWithdrawals.findOne({
        transaction_hash: log.transactionHash,
        chain: vaultConfig.chain
      });
      
      const source = pendingMarker ? 'yieldo' : 'lagoon';

      await colWithdrawals.updateOne(
        { transaction_hash: log.transactionHash, chain: vaultConfig.chain },
        {
          $setOnInsert: {
            user_address: user,
            vault_address: vaultConfig.address,
            vault_id: vaultConfig.id,
            vault_name: vaultConfig.name,
            chain: vaultConfig.chain,
            asset_symbol: vaultConfig.asset.symbol,
            asset_decimals: vaultConfig.asset.decimals,
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
      
      if (pendingMarker) {
        await colPendingYieldoWithdrawals.deleteOne({ transaction_hash: log.transactionHash, chain: vaultConfig.chain });
      }
    }

    let redeemSettledLogs = [];
    try {
      redeemSettledLogs = await client.getLogs({
        address: vaultConfig.address,
        event: parseAbiItem('event RedeemSettled(address indexed controller, address indexed owner, uint256 indexed requestId, address receiver, uint256 assets)'),
        fromBlock,
        toBlock,
      });
    } catch (e) {
      console.log(`[${vaultConfig.id}] ERC-7540 RedeemSettled event not found`);
    }
    
    let lagoonRedeemSettledLogs = [];
    if (redeemSettledLogs.length === 0) {
      try {
        lagoonRedeemSettledLogs = await client.getLogs({
          address: vaultConfig.address,
          event: parseAbiItem('event RedeemSettled(address indexed user, uint256 indexed epochId, uint256 assets)'),
          fromBlock,
          toBlock,
        });
      } catch (e) {
        console.log(`[${vaultConfig.id}] Lagoon RedeemSettled event not found`);
      }
    }

    for (const log of redeemSettledLogs) {
      const { controller, owner, requestId, receiver, assets } = log.args;
      await colWithdrawals.updateOne(
        { user_address: owner, vault_address: vaultConfig.address, chain: vaultConfig.chain, epoch_id: Number(requestId) },
        { $set: { assets: assets.toString(), status: 'settled', settled_at: new Date() } }
      );
    }

    for (const log of lagoonRedeemSettledLogs) {
      const { user, epochId, assets } = log.args;
      await colWithdrawals.updateOne(
        { user_address: user, vault_address: vaultConfig.address, chain: vaultConfig.chain, epoch_id: Number(epochId) },
        { $set: { assets: assets.toString(), status: 'settled', settled_at: new Date() } }
      );
    }

  } catch (error) {
    if (error.message && (error.message.includes('after last accepted block') || error.message.includes('requested from block'))) {
      const finalityError = new Error(`[${vaultConfig.id}] Block range ${fromBlock}-${toBlock} not yet finalized`);
      finalityError.name = 'BlockNotFinalizedError';
      throw finalityError;
    }
    console.error(`[${vaultConfig.id}] Error indexing vault events:`, error);
    throw error;
  }
}

