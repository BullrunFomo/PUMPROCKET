require('dotenv').config();
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors   = require('cors');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const db     = require('./db');

// ─── Solana (deposit monitoring + withdrawals only) ───────────────────────────
const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');

// House wallet: the single address users deposit into, and withdrawals come from
const keypairPath = path.join(__dirname, 'authority-keypair.json');
let authority;
if (process.env.AUTHORITY_KEYPAIR) {
  authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.env.AUTHORITY_KEYPAIR)));
} else if (fs.existsSync(keypairPath)) {
  authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(keypairPath))));
} else {
  authority = Keypair.generate();
  fs.writeFileSync(keypairPath, JSON.stringify(Array.from(authority.secretKey)));
  console.log('🔑 New house wallet saved to authority-keypair.json');
}
console.log('🏦 House wallet:', authority.publicKey.toString());

// ─── Express + Socket.IO ──────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/docs',       (_req, res) => res.sendFile(path.join(__dirname, 'docs.html')));
app.get('/disclaimer', (_req, res) => res.sendFile(path.join(__dirname, 'disclaimer.html')));

// ─── Profile API ──────────────────────────────────────────────────────────────
app.get('/api/profile/:wallet', async (req, res) => {
  if (!db) return res.json({});
  const { data, error } = await db.from('users').select('wallet,username,photo_url,total_bets,total_won,biggest_win').eq('wallet', req.params.wallet).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || {});
});

app.post('/api/profile', async (req, res) => {
  if (!db) return res.json({ ok: true });
  const { wallet, username, photo_url } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  const { error } = await db.from('users').upsert(
    { wallet, username, photo_url, last_seen: new Date().toISOString() },
    { onConflict: 'wallet' }
  );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── Account API ──────────────────────────────────────────────────────────────

// Network mode info
app.get('/api/network', (_req, res) => {
  let mode;
  if (!db) {
    mode = 'demo';
  } else if (SOLANA_RPC.includes('mainnet')) {
    mode = 'mainnet';
  } else {
    mode = 'devnet';
  }
  res.json({ mode });
});

// The address users send SOL to in order to deposit
app.get('/api/deposit-address', (_req, res) => {
  res.json({ address: authority.publicKey.toString() });
});

// Query a wallet's current balance (in lamports)
app.get('/api/balance', async (req, res) => {
  if (!db) return res.json({ balance_lamports: 0 });
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  try {
    const balance_lamports = await db.getBalance(wallet);
    res.json({ balance_lamports });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Withdraw SOL from the user's account to their wallet
app.post('/api/withdraw', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  const { wallet, amount_lamports } = req.body;
  if (!wallet || !amount_lamports) return res.status(400).json({ error: 'wallet and amount_lamports required' });

  const lamports = parseInt(amount_lamports);
  if (isNaN(lamports) || lamports < 10_000_000) {
    return res.status(400).json({ error: 'Minimum withdrawal is 0.01 SOL' });
  }

  let destPubkey;
  try { destPubkey = new PublicKey(wallet); } catch {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  // 1. Atomic debit — throws if balance is insufficient
  try {
    await db.debitBalance(wallet, lamports);
  } catch {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  // 2. Send SOL on-chain
  try {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey:   destPubkey,
        lamports:   BigInt(lamports),
      })
    );
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = authority.publicKey;
    tx.sign(authority);

    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, 'confirmed');

    await db.logTransaction(wallet, 'withdrawal', lamports, sig);

    const balance_lamports = await db.getBalance(wallet);
    const socketId = walletSockets[wallet];
    if (socketId) io.to(socketId).emit('balanceUpdate', { balance_lamports });

    console.log(`[withdraw] ${(lamports / 1e9).toFixed(6)} SOL → ${wallet.slice(0, 8)}... | ${sig}`);
    res.json({ ok: true, signature: sig, balance_lamports });
  } catch (e) {
    // Transfer failed — refund the debited balance
    console.error('[withdraw] Transfer failed, refunding:', e.message);
    await db.creditBalance(wallet, lamports).catch(() => {});
    res.status(500).json({ error: 'Transfer failed: ' + e.message });
  }
});

// ─── Game State API ───────────────────────────────────────────────────────────
app.get('/api/state',   (_req, res) => res.json({ phase: game.phase, roundId: game.roundId, multiplier: game.multiplier, countdown: game.countdown, history: game.history }));
app.get('/api/history', (_req, res) => res.json({ history: game.history }));

// ─── Game State ───────────────────────────────────────────────────────────────
let game = {
  phase:      'waiting',
  roundId:    1,
  crashPoint: 1.00,
  multiplier: 1.00,
  startTime:  null,
  bets:       {},
  history:    [],
  countdown:  20,
  flyingInterval:    null,
  countdownInterval: null,
};

// ─── House Edge Config ────────────────────────────────────────────────────────
const HOUSE_EDGE  = 0.01;  // 1% baked into crash point distribution
const CASHOUT_FEE = 0.01;  // 1% fee on every cashout payout
const FEE_WALLET  = '35HsLa2JTKMaZBTNNvdfRdYQbd3FrFvFvsqSdBSDXuJC';
let   totalFeesCollected = 0;

// ─── Provably Fair ────────────────────────────────────────────────────────────
function generateCrashPoint() {
  const salt = crypto.randomBytes(32);
  const seed = `${game.roundId}-${Date.now()}-${salt.toString('hex')}`;
  const hash = crypto.createHmac('sha256', process.env.HOUSE_SECRET || 'CHANGE_ME_IN_PRODUCTION').update(seed).digest('hex');
  const h    = parseInt(hash.slice(0, 8), 16);
  const e    = Math.pow(2, 32);
  const raw  = Math.floor(((1 - HOUSE_EDGE) * 100 * e - h) / (e - h)) / 100;
  return Math.max(1.00, raw);
}

// ─── Game Loop ────────────────────────────────────────────────────────────────
function startCountdown() {
  clearInterval(game.flyingInterval);
  clearInterval(game.countdownInterval);
  game.flyingInterval = null;

  game.phase      = 'waiting';
  game.bets       = {};
  game.multiplier = 1.00;
  game.countdown  = 20;
  game.crashPoint = generateCrashPoint();

  console.log(`[round ${game.roundId}] countdown started`);
  io.emit('phase', { phase: 'waiting', roundId: game.roundId, countdown: game.countdown });

  game.countdownInterval = setInterval(() => {
    game.countdown--;
    io.emit('countdown', game.countdown);
    if (game.countdown <= 0) {
      clearInterval(game.countdownInterval);
      game.countdownInterval = null;
      startFlying();
    }
  }, 1000);
}

function startFlying() {
  game.phase      = 'flying';
  game.multiplier = 1.00;
  game.startTime  = Date.now();

  io.emit('phase', { phase: 'flying', roundId: game.roundId });

  game.flyingInterval = setInterval(() => {
    const elapsed = (Date.now() - game.startTime) / 1000;
    game.multiplier = parseFloat(Math.pow(Math.E, 0.09 * elapsed).toFixed(2));

    // Auto-cashout check
    for (const [wallet, bet] of Object.entries(game.bets)) {
      if (!bet.cashedOut && bet.autoCashOut && game.multiplier >= bet.autoCashOut) {
        const result = processCashOut(wallet);
        if (result) {
          const socketId = walletSockets[wallet];
          if (socketId) io.to(socketId).emit('cashedOut', { multiplier: result.cashOutAt, payout: result.payout, amount: result.amount });
          io.emit('playerCashedOut', { wallet: wallet.slice(0, 6) + '...' + wallet.slice(-4), multiplier: result.cashOutAt });
        }
      }
    }

    io.emit('tick', { multiplier: game.multiplier, elapsed });

    if (game.multiplier >= game.crashPoint) {
      clearInterval(game.flyingInterval);
      game.flyingInterval = null;
      doCrash();
    }
  }, 50);
}

function doCrash() {
  game.phase = 'crashed';
  const cp   = parseFloat(game.crashPoint.toFixed(2));

  game.history.unshift(cp);
  if (game.history.length > 20) game.history.pop();

  // Log losses for uncashed bets (balance was already debited when bet was placed)
  for (const [wallet, bet] of Object.entries(game.bets)) {
    if (!bet.cashedOut) {
      bet.lost = true;
      if (db) db.logTransaction(wallet, 'loss', Math.round(bet.amount * 1e9), String(game.roundId)).catch(() => {});
    }
  }

  io.emit('crashed', { crashPoint: cp, history: [...game.history] });
  game.roundId++;
  setTimeout(startCountdown, 4000);
}

function processCashOut(wallet) {
  const bet = game.bets[wallet];
  if (!bet || bet.cashedOut) return null;

  bet.cashedOut = true;
  bet.cashOutAt = game.multiplier;
  const gross   = bet.amount * game.multiplier;
  const fee     = parseFloat((gross * CASHOUT_FEE).toFixed(6));
  bet.payout    = parseFloat((gross - fee).toFixed(6));
  totalFeesCollected += fee;
  console.log(`[fees] +${fee.toFixed(4)} SOL → ${FEE_WALLET} (total: ${totalFeesCollected.toFixed(4)} SOL)`);

  // Credit the payout to the player's account (non-blocking — speed is critical here)
  if (db) {
    const payoutLamports = Math.round(bet.payout * 1e9);
    const roundId = String(game.roundId);
    db.creditBalance(wallet, payoutLamports)
      .then(() => db.logTransaction(wallet, 'cashout', payoutLamports, roundId))
      .then(async () => {
        const balance_lamports = await db.getBalance(wallet);
        const sid = walletSockets[wallet];
        if (sid) io.to(sid).emit('balanceUpdate', { balance_lamports });
      })
      .catch(e => console.error('[cashout] balance update failed:', e.message));
  }

  return bet;
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const walletSockets = {};
const chatHistory   = [];

(async () => {
  if (!db) return;
  const { data } = await db.from('chat_messages')
    .select('name,text,photo,created_at')
    .order('created_at', { ascending: true })
    .limit(50);
  if (data) data.forEach(r => chatHistory.push({ name: r.name, text: r.text, photo: r.photo || null, ts: new Date(r.created_at).getTime() }));
})();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  const networkMode = !db ? 'demo' : SOLANA_RPC.includes('mainnet') ? 'mainnet' : 'devnet';
  socket.emit('init', {
    phase:      game.phase,
    roundId:    game.roundId,
    multiplier: game.multiplier,
    countdown:  game.countdown,
    history:    [...game.history],
    network:    networkMode,
  });

  if (chatHistory.length > 0) socket.emit('chatHistory', chatHistory);
  io.emit('onlineCount', io.sockets.sockets.size);

  socket.on('register', async ({ wallet }) => {
    if (!wallet) return;
    walletSockets[wallet] = socket.id;
    if (db) {
      db.from('users').upsert({ wallet, last_seen: new Date().toISOString() }, { onConflict: 'wallet' }).then(() => {});
      try {
        const balance_lamports = await db.getBalance(wallet);
        socket.emit('balanceUpdate', { balance_lamports });
      } catch (e) {
        console.error('[register] getBalance failed:', e.message);
      }
    }
  });

  socket.on('placeBet', async ({ wallet, amount, autoCashOut }) => {
    if (!wallet)  return socket.emit('betError', 'No wallet provided.');
    amount = parseFloat(amount);
    if (!amount || amount <= 0 || isNaN(amount)) return socket.emit('betError', 'Invalid amount.');
    if (game.phase !== 'waiting')  return socket.emit('betError', 'Betting is closed. Wait for next round.');
    if (game.bets[wallet])         return socket.emit('betError', 'Bet already placed this round.');

    const lamports = Math.round(amount * 1e9);
    if (db) {
      try {
        await db.debitBalance(wallet, lamports);
        await db.logTransaction(wallet, 'bet', lamports, String(game.roundId));
      } catch {
        return socket.emit('betError', 'Insufficient balance. Deposit more SOL to play.');
      }
    }

    game.bets[wallet] = {
      amount,
      cashedOut:   false,
      autoCashOut: autoCashOut && parseFloat(autoCashOut) >= 1.01 ? parseFloat(autoCashOut) : null,
    };

    socket.emit('betConfirmed', { amount, autoCashOut: game.bets[wallet].autoCashOut });

    // Send updated balance immediately
    if (db) {
      try {
        const balance_lamports = await db.getBalance(wallet);
        socket.emit('balanceUpdate', { balance_lamports });
      } catch {}
    }

    if (db) db.rpc('track_bet', { p_wallet: wallet }).then(() => {});
    io.emit('betPlaced', { wallet: wallet.slice(0, 6) + '...' + wallet.slice(-4), amount });
  });

  socket.on('cashOut', ({ wallet }) => {
    if (!wallet) return socket.emit('cashOutError', 'No wallet.');
    if (game.phase !== 'flying')  return socket.emit('cashOutError', 'Game not in progress.');
    const bet = game.bets[wallet];
    if (!bet)          return socket.emit('cashOutError', 'No active bet found.');
    if (bet.cashedOut) return socket.emit('cashOutError', 'Already cashed out.');

    const result = processCashOut(wallet);
    if (!result) return socket.emit('cashOutError', 'Cash out failed.');

    socket.emit('cashedOut', { multiplier: result.cashOutAt, payout: result.payout, amount: result.amount });
    io.emit('playerCashedOut', { wallet: wallet.slice(0, 6) + '...' + wallet.slice(-4), multiplier: result.cashOutAt });
    if (db) db.rpc('track_cashout', { p_wallet: wallet, p_profit: result.payout - result.amount, p_biggest: result.payout }).then(() => {});
  });

  socket.on('chatMessage', ({ name, text, photo }) => {
    if (!text || typeof text !== 'string') return;
    const msg = { name: String(name || 'Anon').slice(0, 32), text: text.slice(0, 200), photo: photo || null, ts: Date.now() };
    chatHistory.push(msg);
    if (chatHistory.length > 50) chatHistory.shift();
    io.emit('chatMessage', msg);
    if (db) db.from('chat_messages').insert({ name: msg.name, text: msg.text, photo: msg.photo }).then(() => {});
  });

  socket.on('disconnect', () => {
    for (const [w, sid] of Object.entries(walletSockets)) {
      if (sid === socket.id) delete walletSockets[w];
    }
    console.log('Client disconnected:', socket.id);
    io.emit('onlineCount', io.sockets.sockets.size);
  });
});

// ─── Deposit Monitor ──────────────────────────────────────────────────────────
async function monitorDeposits() {
  if (!db) return;
  try {
    const sigs = await connection.getSignaturesForAddress(authority.publicKey, { limit: 100 });
    // Filter out failed txs immediately — no RPC call needed, err is in the sig info
    const successSigs = sigs.filter(s => !s.err);
    console.log(`[deposits] checking ${successSigs.length}/${sigs.length} successful signatures`);

    for (const { signature } of successSigs) {
      const already = await db.isDepositProcessed(signature);
      if (already) continue;

      const tx = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) { console.log(`[deposits] tx not found: ${signature.slice(0,12)}`); continue; }
      if (tx.meta?.err) continue; // double-check

      const houseKey = authority.publicKey.toString();
      const rawKeys  = tx.transaction.message.accountKeys || tx.transaction.message.staticAccountKeys || [];
      const accounts = rawKeys.map(k => (typeof k.toString === 'function' ? k.toString() : String(k)));
      console.log(`[deposits] sig ${signature.slice(0,12)} accounts:`, accounts.slice(0, 3));

      const houseIdx = accounts.indexOf(houseKey);
      if (houseIdx === -1) { console.log(`[deposits] house wallet not in accounts, skipping`); continue; }

      const received = tx.meta.postBalances[houseIdx] - tx.meta.preBalances[houseIdx];
      console.log(`[deposits] received by house: ${received} lamports`);
      if (received < 1_000_000) { console.log(`[deposits] dust, skipping`); continue; }

      const sender = accounts[0];
      if (sender === houseKey) { console.log(`[deposits] outgoing tx, skipping`); continue; }

      console.log(`[deposits] crediting ${(received / 1e9).toFixed(6)} SOL to ${sender.slice(0, 8)}...`);
      await db.recordDeposit(signature, sender, received);
      console.log(`[deposit] ✓ credited!`);

      const socketId = walletSockets[sender];
      if (socketId) {
        const balance_lamports = await db.getBalance(sender);
        io.to(socketId).emit('balanceUpdate', { balance_lamports });
      }
    }
  } catch (e) {
    console.error('[deposits] Monitor error:', e.message, e.stack);
  }
}

// Run immediately on startup, then every 30 seconds
monitorDeposits();
setInterval(monitorDeposits, 30_000);

// Debug endpoint: manually trigger deposit check
app.get('/api/admin/check-deposits', async (_req, res) => {
  await monitorDeposits();
  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Crash game running at http://localhost:${PORT}`);
  console.log(`🏦 House wallet (deposit here): ${authority.publicKey.toString()}`);
  startCountdown();
});
