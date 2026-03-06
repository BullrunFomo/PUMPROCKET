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

-- 6. User profiles & lifetime stats
CREATE TABLE IF NOT EXISTS users (
  wallet      TEXT        PRIMARY KEY,
  username    TEXT,
  photo_url   TEXT,
  total_bets  INTEGER     NOT NULL DEFAULT 0,
  total_won   NUMERIC     NOT NULL DEFAULT 0,  -- cumulative net profit (SOL)
  biggest_win NUMERIC     NOT NULL DEFAULT 0,  -- largest single payout (SOL)
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet);

-- 7. Chat messages (last 50 loaded on connect)
CREATE TABLE IF NOT EXISTS chat_messages (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  text       TEXT        NOT NULL,
  photo      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE chat_messages DISABLE ROW LEVEL SECURITY;

-- 8. Increment total_bets for a wallet (called on every placeBet)
CREATE OR REPLACE FUNCTION track_bet(p_wallet TEXT)
RETURNS VOID AS $$
BEGIN
  INSERT INTO users (wallet, total_bets)
  VALUES (p_wallet, 1)
  ON CONFLICT (wallet) DO UPDATE
    SET total_bets = users.total_bets + 1;
END;
$$ LANGUAGE plpgsql;

-- 9. Update stats after a cashout
CREATE OR REPLACE FUNCTION track_cashout(p_wallet TEXT, p_profit NUMERIC, p_biggest NUMERIC)
RETURNS VOID AS $$
BEGIN
  UPDATE users
  SET total_won   = total_won   + GREATEST(p_profit, 0),
      biggest_win = GREATEST(biggest_win, p_biggest)
  WHERE wallet = p_wallet;
END;
$$ LANGUAGE plpgsql;

-- 10. Active bets (in-progress bets, used to restore state on page refresh)
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
GRANT EXECUTE ON FUNCTION credit_balance  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION debit_balance   TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION track_bet       TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION track_cashout   TO anon, authenticated, service_role;
