const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
// Prefer the service role key on the backend — it bypasses RLS entirely.
// If you only have the anon key, run the extra SQL in supabase-migration.sql first.
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.warn('[db] SUPABASE_URL / SUPABASE_ANON_KEY not set — DB disabled');
  module.exports = null;
} else {
  const db = createClient(url, key);
  console.log('[db] Supabase connected:', url);

  // ─── Balance helpers ──────────────────────────────────────────────────────

  db.getBalance = async function (wallet) {
    const { data, error } = await this
      .from('user_balances')
      .select('balance_lamports')
      .eq('wallet', wallet)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? Number(data.balance_lamports) : 0;
  };

  // Atomically add lamports — creates row if it doesn't exist
  db.creditBalance = async function (wallet, lamports) {
    const { data, error } = await this.rpc('credit_balance', {
      p_wallet: wallet,
      p_amount: lamports,
    });
    if (error) throw new Error(error.message);
    return Number(data);
  };

  // Atomically subtract lamports — throws if balance is insufficient
  db.debitBalance = async function (wallet, lamports) {
    const { data, error } = await this.rpc('debit_balance', {
      p_wallet: wallet,
      p_amount: lamports,
    });
    if (error) throw new Error(error.message);
    return Number(data);
  };

  // ─── Deposit tracking ────────────────────────────────────────────────────

  db.isDepositProcessed = async function (signature) {
    const { data, error } = await this
      .from('processed_deposits')
      .select('signature')
      .eq('signature', signature)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  };

  // Record a deposit and credit the sender's balance in one operation
  db.recordDeposit = async function (signature, wallet, lamports) {
    const { error } = await this
      .from('processed_deposits')
      .insert({ signature, wallet, amount_lamports: lamports });
    if (error) throw new Error(error.message);
    await this.creditBalance(wallet, lamports);
    await this.logTransaction(wallet, 'deposit', lamports, signature);
  };

  // ─── Audit trail ─────────────────────────────────────────────────────────

  db.logTransaction = async function (wallet, type, lamports, reference = null) {
    const { error } = await this
      .from('transactions')
      .insert({ wallet, type, amount_lamports: lamports, reference });
    if (error) console.error('[db] logTransaction error:', error.message);
  };

  module.exports = db;
}
