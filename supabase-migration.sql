-- ============================================================
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- 1. User balances (server-tracked SOL deposits)
CREATE TABLE IF NOT EXISTS user_balances (
  wallet           TEXT        PRIMARY KEY,
  balance_lamports BIGINT      NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Processed deposits (prevents double-crediting the same tx)
CREATE TABLE IF NOT EXISTS processed_deposits (
  signature        TEXT        PRIMARY KEY,
  wallet           TEXT        NOT NULL,
  amount_lamports  BIGINT      NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Full transaction ledger (bets, wins, deposits, withdrawals)
CREATE TABLE IF NOT EXISTS transactions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet           TEXT        NOT NULL,
  type             TEXT        NOT NULL,   -- 'deposit' | 'withdrawal' | 'bet' | 'cashout' | 'loss'
  amount_lamports  BIGINT      NOT NULL,
  reference        TEXT,                   -- tx signature for on-chain events, round_id for game events
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Atomic credit function (INSERT … ON CONFLICT ADD)
CREATE OR REPLACE FUNCTION credit_balance(p_wallet TEXT, p_amount BIGINT)
RETURNS BIGINT AS $$
DECLARE
  new_balance BIGINT;
BEGIN
  INSERT INTO user_balances (wallet, balance_lamports, updated_at)
  VALUES (p_wallet, p_amount, NOW())
  ON CONFLICT (wallet) DO UPDATE
    SET balance_lamports = user_balances.balance_lamports + p_amount,
        updated_at       = NOW()
  RETURNING balance_lamports INTO new_balance;
  RETURN new_balance;
END;
$$ LANGUAGE plpgsql;

-- 5. Atomic debit function (fails if balance is insufficient)
CREATE OR REPLACE FUNCTION debit_balance(p_wallet TEXT, p_amount BIGINT)
RETURNS BIGINT AS $$
DECLARE
  new_balance BIGINT;
BEGIN
  UPDATE user_balances
  SET balance_lamports = balance_lamports - p_amount,
      updated_at       = NOW()
  WHERE wallet = p_wallet
    AND balance_lamports >= p_amount
  RETURNING balance_lamports INTO new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  RETURN new_balance;
END;
$$ LANGUAGE plpgsql;

-- 4. Active bets (in-progress bets, used to restore state on page refresh)
CREATE TABLE IF NOT EXISTS active_bets (
  wallet           TEXT        PRIMARY KEY,
  amount_sol       NUMERIC     NOT NULL,
  amount_lamports  BIGINT      NOT NULL,
  round_id         INTEGER     NOT NULL,
  auto_cash_out    NUMERIC,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE active_bets DISABLE ROW LEVEL SECURITY;

-- Optional: indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet);
CREATE INDEX IF NOT EXISTS idx_processed_deposits_wallet ON processed_deposits(wallet);
CREATE INDEX IF NOT EXISTS idx_active_bets_round ON active_bets(round_id);

-- ─── RLS + permissions ────────────────────────────────────────────────────────
-- These tables are server-only (never accessed by the browser directly),
-- so disable RLS and grant full access to the service role / anon role.
ALTER TABLE user_balances      DISABLE ROW LEVEL SECURITY;
ALTER TABLE processed_deposits DISABLE ROW LEVEL SECURITY;
ALTER TABLE transactions       DISABLE ROW LEVEL SECURITY;

-- Allow the anon role to call the balance RPC functions
GRANT EXECUTE ON FUNCTION credit_balance TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION debit_balance  TO anon, authenticated, service_role;
