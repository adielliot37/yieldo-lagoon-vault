-- Yieldo MVP Database Schema
-- PostgreSQL database initialization

CREATE DATABASE IF NOT EXISTS yieldo;

-- Deposit intents table (EIP-712 signed intents)
CREATE TABLE IF NOT EXISTS deposit_intents (
    id SERIAL PRIMARY KEY,
    intent_hash VARCHAR(66) UNIQUE NOT NULL,
    user_address VARCHAR(42) NOT NULL,
    vault_address VARCHAR(42) NOT NULL,
    asset_address VARCHAR(42) NOT NULL,
    amount VARCHAR(78) NOT NULL,
    nonce BIGINT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    executed_at TIMESTAMP
);

-- Confirmed deposits table
CREATE TABLE IF NOT EXISTS deposits (
    id SERIAL PRIMARY KEY,
    intent_hash VARCHAR(66) REFERENCES deposit_intents(intent_hash),
    user_address VARCHAR(42) NOT NULL,
    vault_address VARCHAR(42) NOT NULL,
    amount VARCHAR(78) NOT NULL,
    shares VARCHAR(78),
    epoch_id INTEGER,
    status VARCHAR(20) DEFAULT 'pending',
    block_number BIGINT,
    transaction_hash VARCHAR(66),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Withdrawals table
CREATE TABLE IF NOT EXISTS withdrawals (
    id SERIAL PRIMARY KEY,
    user_address VARCHAR(42) NOT NULL,
    vault_address VARCHAR(42) NOT NULL,
    shares VARCHAR(78) NOT NULL,
    assets VARCHAR(78),
    epoch_id INTEGER,
    status VARCHAR(20) DEFAULT 'pending',
    block_number BIGINT,
    transaction_hash VARCHAR(66),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Daily snapshots table
CREATE TABLE IF NOT EXISTS snapshots (
    id SERIAL PRIMARY KEY,
    date DATE UNIQUE NOT NULL,
    vault_address VARCHAR(42) NOT NULL,
    total_assets VARCHAR(78) NOT NULL,
    total_supply VARCHAR(78) NOT NULL,
    total_deposits VARCHAR(78) DEFAULT '0',
    total_withdrawals VARCHAR(78) DEFAULT '0',
    deposit_epoch_id INTEGER,
    redeem_epoch_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_deposit_intents_user ON deposit_intents(user_address);
CREATE INDEX IF NOT EXISTS idx_deposit_intents_status ON deposit_intents(status);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_address);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_address);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_snapshots_date ON snapshots(date);
CREATE INDEX IF NOT EXISTS idx_snapshots_vault ON snapshots(vault_address);


