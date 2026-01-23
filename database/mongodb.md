# MongoDB (Atlas) storage model

The indexer (`indexer/src/index.js`) uses MongoDB Atlas (recommended) and creates collections + indexes automatically on startup.

## Collections

### `deposit_intents`
- **Key fields**: `intent_hash` (unique), `user_address`, `vault_address`, `asset_address`, `amount` (string, base units), `nonce` (string), `status`, `created_at`, `executed_at`
- **Indexes**:
  - `intent_hash` unique
  - `{ user_address, created_at }`

### `deposits`
- **Key fields**: `intent_hash`, `user_address`, `vault_address`, `amount` (string, base units), `shares` (string|null), `epoch_id` (number|null), `status`, `block_number` (string), `transaction_hash`, `created_at`
- **Indexes**:
  - `{ user_address, created_at }`
  - `transaction_hash`

### `withdrawals`
- **Key fields**: `user_address`, `vault_address`, `shares` (string), `assets` (string|null), `epoch_id` (number), `status`, `block_number` (string), `transaction_hash`, `created_at`
- **Indexes**:
  - `{ user_address, created_at }`

### `snapshots`
- **Key fields**: `date` (YYYY-MM-DD), `vault_address`, `total_assets`, `total_supply`, `total_deposits`, `total_withdrawals`, `deposit_epoch_id`, `redeem_epoch_id`, `created_at`
- **Indexes**:
  - `{ date, vault_address }` unique

### `meta`
- Used to persist indexer state.
- Document example:
  - `{ _id: \"lastProcessedBlock\", value: \"12345678\", updated_at: Date }`



