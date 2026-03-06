require('dotenv').config();
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors   = require('cors');
const helmet = require('helmet');
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

// ─── Security checks ──────────────────────────────────────────────────────────
if (!process.env.HOUSE_SECRET || process.env.HOUSE_SECRET === 'CHANGE_ME_IN_PRODUCTION') {
  console.error('FATAL: HOUSE_SECRET env var is not set or still uses the default value.');
  console.error('Set a strong random secret in your .env file: HOUSE_SECRET=<random string>');
  process.exit(1);
}

// ─── Express + Socket.IO ──────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || false; // set to your domain in production
const ADMIN_SECRET   = process.env.ADMIN_SECRET   || null;  // set in .env to protect admin endpoints

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: ALLOWED_ORIGIN || false } });

app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled so inline scripts in index.html still work
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || false })); // false = same-origin only; set ALLOWED_ORIGIN in prod
app.use(express.json({ limit: '10mb' })); // 10mb to allow base64 avatar uploads

app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/docs',       (_req, res) => res.sendFile(path.join(__dirname, 'docs.html')));
app.get('/disclaimer', (_req, res) => res.sendFile(path.join(__dirname, 'disclaimer.html')));

// ─── Avatar Upload ────────────────────────────────────────────────────────────
app.post('/api/upload-avatar', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB unavailable' });
  const { wallet, imageBase64, token } = req.body;
  if (!wallet || !imageBase64) return res.status(400).json({ error: 'wallet and imageBase64 required' });

  // Require a valid session token proving the caller owns this wallet
  const session = token ? sessionTokens[token] : null;
  if (!session || session.wallet !== wallet || Date.now() > session.expires) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Validate base64 data URL
  const match = imageBase64.match(/^data:(image\/(png|jpeg|jpg|gif|webp));base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid image format' });

  const mimeType = match[1];
  const ext = match[2] === 'jpeg' ? 'jpg' : match[2];
  const buffer = Buffer.from(match[3], 'base64');

  // Limit to 2MB
  if (buffer.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 2MB)' });

  const fileName = `${wallet}.${ext}`;
  const { error } = await db.storage.from('avatars').upload(fileName, buffer, {
    contentType: mimeType,
    upsert: true,
  });
  if (error) return res.status(500).json({ error: 'Upload failed' });

  const { data: { publicUrl } } = db.storage.from('avatars').getPublicUrl(fileName);
  res.json({ url: publicUrl });
});

// ─── Profile API ──────────────────────────────────────────────────────────────
app.get('/api/profile/:wallet', async (req, res) => {
  if (!db) return res.json({});
  const { data, error } = await db.from('users').select('wallet,username,photo_url,total_bets,total_won,biggest_win').eq('wallet', req.params.wallet).maybeSingle();
  if (error) return res.status(500).json({ error: 'Failed to fetch profile' });
  res.json(data || {});
});

app.post('/api/profile', async (req, res) => {
  if (!db) return res.json({ ok: true });
  const { wallet, username, photo_url, token } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });

  // Require a valid session token proving the caller owns this wallet
  const session = token ? sessionTokens[token] : null;
  if (!session || session.wallet !== wallet || Date.now() > session.expires) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Validate photo_url: must be http/https URL or small data URL (thumbnail)
  const validPhoto = !photo_url || /^https?:\/\//i.test(photo_url) || (/^data:image\/(png|jpeg|gif|webp);base64,/.test(photo_url) && photo_url.length < 30000);
  if (!validPhoto) return res.status(400).json({ error: 'Invalid photo URL' });
  const safeUsername = typeof username === 'string' ? username.slice(0, 32) : '';
  const { error } = await db.from('users').upsert(
    { wallet, username: safeUsername, photo_url: photo_url || null, last_seen: new Date().toISOString() },
    { onConflict: 'wallet' }
  );
  if (error) return res.status(500).json({ error: 'Profile update failed' });
  // Keep in-memory profile cache fresh
  playerProfiles.set(wallet, { username: safeUsername || null, photo: photo_url || null });
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

// ─── Withdrawal nonce store (prevents replay attacks) ─────────────────────────
const withdrawNonces = new Map(); // `${wallet}:${nonce}` → expiry timestamp

app.get('/api/withdraw-nonce', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  try { new PublicKey(wallet); } catch { return res.status(400).json({ error: 'Invalid wallet' }); }
  const nonce = crypto.randomBytes(16).toString('hex');
  withdrawNonces.set(`${wallet}:${nonce}`, Date.now() + 5 * 60 * 1000); // 5 min expiry
  // Prune expired nonces
  for (const [k, exp] of withdrawNonces) if (Date.now() > exp) withdrawNonces.delete(k);
  res.json({ nonce });
});

// Query a wallet's current balance (in lamports)
app.get('/api/balance', async (req, res) => {
  if (!db) return res.json({ balance_lamports: 0 });
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  try {
    const balance_lamports = await db.getBalance(wallet);
    res.json({ balance_lamports });
  } catch {
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// Withdraw SOL from the user's account to their wallet
app.post('/api/withdraw', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  const { wallet, amount_lamports, signature, nonce } = req.body;
  if (!wallet || !amount_lamports) return res.status(400).json({ error: 'wallet and amount_lamports required' });

  const lamports = parseInt(amount_lamports);
  if (isNaN(lamports) || lamports < 10_000_000) {
    return res.status(400).json({ error: 'Minimum withdrawal is 0.01 SOL' });
  }

  let destPubkey;
  try { destPubkey = new PublicKey(wallet); } catch {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  // Verify one-time nonce
  if (!nonce || !signature) return res.status(401).json({ error: 'Signature required' });
  const nonceKey = `${wallet}:${nonce}`;
  const nonceExpiry = withdrawNonces.get(nonceKey);
  if (!nonceExpiry || Date.now() > nonceExpiry) {
    return res.status(401).json({ error: 'Invalid or expired nonce' });
  }
  withdrawNonces.delete(nonceKey); // one-time use

  // Verify Ed25519 signature from Phantom (signMessage returns Uint8Array)
  try {
    const message = `pumprocket-withdraw:${wallet}:${lamports}:${nonce}`;
    const msgBytes = Buffer.from(message, 'utf8');
    const sigBytes = Buffer.from(signature, 'hex');
    const DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
    const derPub = Buffer.concat([DER_PREFIX, Buffer.from(destPubkey.toBytes())]);
    const pubKey = crypto.createPublicKey({ key: derPub, format: 'der', type: 'spki' });
    const valid = crypto.verify(null, msgBytes, pubKey, sigBytes);
    if (!valid) return res.status(401).json({ error: 'Signature verification failed' });
  } catch {
    return res.status(401).json({ error: 'Signature verification failed' });
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

// Returns the wallet's active bet for the current round (used to restore UI on page refresh)
app.get('/api/active-bet', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.json({ active: false });

  // In-memory check (authoritative for the current server session)
  const bet = game.bets[wallet];
  if (bet && !bet.lost) {
    return res.json({
      active:      true,
      amount:      bet.amount,
      cashedOut:   bet.cashedOut,
      cashOutAt:   bet.cashOutAt  || null,
      payout:      bet.payout     || null,
      autoCashOut: bet.autoCashOut || null,
      roundId:     game.roundId,
    });
  }

  // DB fallback (handles cases where game.bets was cleared)
  if (!db || game.phase === 'crashed') return res.json({ active: false });
  try {
    const dbBet = await db.getActiveBet(wallet);
    if (!dbBet || dbBet.round_id !== game.roundId) return res.json({ active: false });
    return res.json({
      active:      true,
      amount:      parseFloat(dbBet.amount_sol),
      cashedOut:   false,
      cashOutAt:   null,
      payout:      null,
      autoCashOut: dbBet.auto_cash_out ? parseFloat(dbBet.auto_cash_out) : null,
      roundId:     dbBet.round_id,
    });
  } catch { return res.json({ active: false }); }
});

// (active_bets are NOT cleared on start — they are restored below)

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

// Per-round lock: wallets whose placeBet is currently awaiting the DB debit.
// Prevents two concurrent placeBet calls from both passing the game.bets check
// before either one writes the result (double-spend race condition).
const pendingBets = new Set();

// ─── House Edge Config ────────────────────────────────────────────────────────
const HOUSE_EDGE         = 0.01;  // 1% baked into crash point distribution
const CASHOUT_FEE        = 0.01;  // 1% fee on every cashout payout
const FEE_WALLET         = 'DjGYTPqUvFvCMR3qneDN3dBg6EezeRF5ssj2T7turi4d';
const FEE_SWEEP_THRESHOLD = 100_000_000; // sweep when 0.1 SOL accumulated
let   pendingFeeLamports = 0;
let   totalFeesCollected = 0;

async function sweepFees() {
  if (pendingFeeLamports < FEE_SWEEP_THRESHOLD) return;
  const amount = pendingFeeLamports;
  pendingFeeLamports = 0; // reset before sending to avoid double-sweep
  try {
    const dest = new PublicKey(FEE_WALLET);
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: dest, lamports: BigInt(amount) })
    );
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = authority.publicKey;
    tx.sign(authority);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    console.log(`[fees] swept ${(amount / 1e9).toFixed(4)} SOL → ${FEE_WALLET} | tx: ${sig}`);
  } catch (e) {
    console.error('[fees] sweep failed:', e.message);
    pendingFeeLamports += amount; // refund on failure
  }
}

// Sweep every hour regardless of threshold
setInterval(async () => { if (pendingFeeLamports > 0) await sweepFees(); }, 60 * 60 * 1000);

// ─── Provably Fair ────────────────────────────────────────────────────────────
function generateCrashPoint() {
  const salt = crypto.randomBytes(32);
  const seed = `${game.roundId}-${Date.now()}-${salt.toString('hex')}`;
  const hash = crypto.createHmac('sha256', process.env.HOUSE_SECRET).update(seed).digest('hex');
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
  pendingBets.clear();
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
  // Remove all active bets from DB (round is over)
  if (db) db.clearAllActiveBets().catch(() => {});

  io.emit('crashed', { crashPoint: cp, history: [...game.history] });
  game.roundId++;
  setTimeout(startCountdown, 4000);
}

function processCashOut(wallet) {
  const bet = game.bets[wallet];
  if (!bet || bet.cashedOut) return null;

  bet.cashedOut = true;
  bet.cashOutAt = game.multiplier;
  if (db) db.removeActiveBet(wallet).catch(() => {});
  const gross      = bet.amount * game.multiplier;
  const fee        = parseFloat((gross * CASHOUT_FEE).toFixed(6));
  bet.payout       = parseFloat((gross - fee).toFixed(6));
  const feeLamports = Math.round(fee * 1e9);
  pendingFeeLamports += feeLamports;
  totalFeesCollected += fee;
  console.log(`[fees] +${fee.toFixed(4)} SOL pending (total pending: ${(pendingFeeLamports / 1e9).toFixed(4)} SOL)`);
  sweepFees(); // sweep if threshold reached

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
const walletSockets    = {};
const socketChallenges = {}; // socketId → nonce (for register auth)
const sessionTokens    = {}; // token → { wallet, expires }
// LRU cache capped at 10,000 entries — Map preserves insertion order so the
// first key is always the least-recently-used entry to evict.
function makeLRU(maxSize) {
  const map = new Map();
  return {
    get(key)      { return map.get(key); },
    set(key, val) { map.delete(key); map.set(key, val); if (map.size > maxSize) map.delete(map.keys().next().value); },
    has(key)      { return map.has(key); },
  };
}
const playerProfiles = makeLRU(10_000); // wallet → { username, photo }
const chatHistory      = [];
const chatRates        = new Map(); // socketId → { count, resetAt }
const registerRates    = new Map(); // socketId → { count, resetAt }

// Clean up expired session tokens hourly
setInterval(() => {
  const now = Date.now();
  for (const [tok, s] of Object.entries(sessionTokens)) {
    if (now > s.expires) delete sessionTokens[tok];
  }
}, 60 * 60 * 1000);

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

  // Issue a one-time challenge so the client can prove wallet ownership
  const nonce = crypto.randomBytes(32).toString('hex');
  socketChallenges[socket.id] = nonce;
  socket.emit('challenge', { nonce });

  const networkMode = !db ? 'demo' : SOLANA_RPC.includes('mainnet') ? 'mainnet' : 'devnet';
  socket.emit('init', {
    phase:       game.phase,
    roundId:     game.roundId,
    multiplier:  game.multiplier,
    countdown:   game.countdown,
    history:     [...game.history],
    network:     networkMode,
    // Send current round's active bets so players panel is restored on refresh
    activeBets:  Object.entries(game.bets)
      .filter(([, b]) => !b.lost)
      .map(([w, b]) => {
        const prof = playerProfiles.get(w) || {};
        return {
          wallet:    w.slice(0, 6) + '...' + w.slice(-4),
          amount:    b.amount,
          cashedOut: b.cashedOut,
          cashOutAt: b.cashOutAt || null,
          username:  prof.username || null,
          photo:     prof.photo    || null,
        };
      }),
  });

  if (chatHistory.length > 0) socket.emit('chatHistory', chatHistory);
  io.emit('onlineCount', io.sockets.sockets.size);

  socket.on('register', async ({ wallet, signature, nonce, token } = {}) => {
    if (!wallet) return;

    // Rate limit: max 5 register attempts per minute per socket
    const _now = Date.now();
    let rr = registerRates.get(socket.id) || { count: 0, resetAt: _now + 60_000 };
    if (_now > rr.resetAt) { rr.count = 0; rr.resetAt = _now + 60_000; }
    rr.count++;
    registerRates.set(socket.id, rr);
    if (rr.count > 5) return;

    // Track whether this socket proved it owns the wallet (signed nonce or valid session token).
    // Required to overwrite an existing active session — prevents cashout DoS via session hijacking.
    let authenticated = false;

    if (token) {
      const session = sessionTokens[token];
      if (session && session.wallet === wallet && Date.now() <= session.expires) {
        session.expires = Date.now() + 24 * 60 * 60 * 1000; // refresh TTL
        authenticated = true;
      }
    } else if (signature && nonce && socketChallenges[socket.id] === nonce) {
      try {
        const message  = `pumprocket-register:${wallet}:${nonce}`;
        const msgBytes = Buffer.from(message, 'utf8');
        const sigBytes = Buffer.from(signature, 'hex');
        const DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
        const derPub = Buffer.concat([DER_PREFIX, Buffer.from(new PublicKey(wallet).toBytes())]);
        const pubKey = crypto.createPublicKey({ key: derPub, format: 'der', type: 'spki' });
        if (crypto.verify(null, msgBytes, pubKey, sigBytes)) {
          authenticated = true;
          const newToken = crypto.randomBytes(32).toString('hex');
          sessionTokens[newToken] = { wallet, expires: Date.now() + 24 * 60 * 60 * 1000 };
          socket.emit('sessionToken', { token: newToken });
        }
      } catch { /* ignore — unauthenticated fallback */ }
    }

    // Guard against session hijacking: if another active socket already owns this wallet,
    // only allow the overwrite if ownership was proved above.
    // Page refresh is safe: the disconnect handler removes walletSockets[wallet] before
    // the new socket arrives, so the slot is empty and no auth is required.
    const existingSocket = walletSockets[wallet];
    if (existingSocket && existingSocket !== socket.id && !authenticated) {
      return; // Reject — cannot displace an authenticated session without proof
    }

    walletSockets[wallet] = socket.id;

    // Restore active bet so a page refresh doesn't lose bet state
    const activeBet = game.bets[wallet];
    if (activeBet && !activeBet.lost) {
      socket.emit('betRestored', {
        amount:      activeBet.amount,
        autoCashOut: activeBet.autoCashOut,
        cashedOut:   activeBet.cashedOut,
        cashOutAt:   activeBet.cashOutAt  || null,
        payout:      activeBet.payout     || null,
      });
    } else if (db && (game.phase === 'flying' || game.phase === 'waiting')) {
      // DB fallback: bet may have been placed in this round before a server restart
      try {
        const dbBet = await db.getActiveBet(wallet);
        if (dbBet && dbBet.round_id === game.roundId) {
          // Rebuild in-memory bet so cashOut works
          game.bets[wallet] = {
            amount:      parseFloat(dbBet.amount_sol),
            cashedOut:   false,
            autoCashOut: dbBet.auto_cash_out ? parseFloat(dbBet.auto_cash_out) : null,
          };
          socket.emit('betRestored', {
            amount:      parseFloat(dbBet.amount_sol),
            autoCashOut: game.bets[wallet].autoCashOut,
            cashedOut:   false,
            cashOutAt:   null,
            payout:      null,
          });
        }
      } catch (e) { console.error('[register] DB bet restore failed:', e.message); }
    }

    if (db) {
      db.from('users').upsert({ wallet, last_seen: new Date().toISOString() }, { onConflict: 'wallet' }).then(() => {});
      // Cache profile (awaited so it's ready before the player can place a bet)
      try {
        const { data: prof } = await db.from('users').select('username,photo_url').eq('wallet', wallet).maybeSingle();
        if (prof) playerProfiles.set(wallet, { username: prof.username || null, photo: prof.photo_url || null });
      } catch {}
      try {
        const balance_lamports = await db.getBalance(wallet);
        socket.emit('balanceUpdate', { balance_lamports });
      } catch (e) {
        console.error('[register] getBalance failed:', e.message);
      }
    }
  });

  socket.on('placeBet', async ({ wallet, amount, autoCashOut }) => {
    if (!wallet || walletSockets[wallet] !== socket.id) return socket.emit('betError', 'Wallet not registered to this session.');
    amount = parseFloat(amount);
    if (!amount || amount <= 0 || isNaN(amount)) return socket.emit('betError', 'Invalid amount.');
    if (game.phase !== 'waiting')  return socket.emit('betError', 'Betting is closed. Wait for next round.');
    if (game.bets[wallet])         return socket.emit('betError', 'Bet already placed this round.');
    if (pendingBets.has(wallet))   return socket.emit('betError', 'Bet already in progress.');

    pendingBets.add(wallet); // hold the lock before any async work
    const lamports = Math.round(amount * 1e9);
    if (db) {
      try {
        await db.debitBalance(wallet, lamports);
        await db.logTransaction(wallet, 'bet', lamports, String(game.roundId));
      } catch {
        pendingBets.delete(wallet);
        return socket.emit('betError', 'Insufficient balance. Deposit more SOL to play.');
      }
    }
    pendingBets.delete(wallet);

    game.bets[wallet] = {
      amount,
      cashedOut:   false,
      autoCashOut: autoCashOut && parseFloat(autoCashOut) >= 1.01 ? parseFloat(autoCashOut) : null,
    };

    // Persist active bet to DB so it survives page refresh and server restart
    if (db) db.saveActiveBet(wallet, amount, lamports, game.roundId, game.bets[wallet].autoCashOut).catch(() => {});

    socket.emit('betConfirmed', { amount, autoCashOut: game.bets[wallet].autoCashOut });

    // Send updated balance immediately
    if (db) {
      try {
        const balance_lamports = await db.getBalance(wallet);
        socket.emit('balanceUpdate', { balance_lamports });
      } catch {}
    }

    if (db) db.rpc('track_bet', { p_wallet: wallet }).then(() => {});
    // Fallback: fetch profile now if still not cached (e.g. register race)
    if (db && !playerProfiles.has(wallet)) {
      try {
        const { data: prof } = await db.from('users').select('username,photo_url').eq('wallet', wallet).maybeSingle();
        if (prof) playerProfiles.set(wallet, { username: prof.username || null, photo: prof.photo_url || null });
      } catch {}
    }
    const prof = playerProfiles.get(wallet) || {};
    io.emit('betPlaced', { wallet: wallet.slice(0, 6) + '...' + wallet.slice(-4), amount, username: prof.username || null, photo: prof.photo || null });
  });

  socket.on('cashOut', ({ wallet } = {}) => {
    if (!wallet || walletSockets[wallet] !== socket.id) return socket.emit('cashOutError', 'Wallet not registered to this session.');
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
    // Rate limit: max 2 messages per 3 seconds
    const now = Date.now();
    let rate = chatRates.get(socket.id) || { count: 0, resetAt: now + 3000 };
    if (now > rate.resetAt) { rate.count = 0; rate.resetAt = now + 3000; }
    rate.count++;
    chatRates.set(socket.id, rate);
    if (rate.count > 2) return;
    const safePhoto = (typeof photo === 'string' && (/^https?:\/\//i.test(photo) || (/^data:image\/(png|jpeg|gif|webp);base64,/.test(photo) && photo.length < 30000))) ? photo : null;
    const msg = { name: String(name || 'Anon').slice(0, 32), text: text.slice(0, 200), photo: safePhoto, ts: Date.now() };
    chatHistory.push(msg);
    if (chatHistory.length > 50) chatHistory.shift();
    io.emit('chatMessage', msg);
    if (db) db.from('chat_messages').insert({ name: msg.name, text: msg.text, photo: msg.photo }).then(() => {});
  });

  socket.on('disconnect', () => {
    chatRates.delete(socket.id);
    registerRates.delete(socket.id);
    delete socketChallenges[socket.id];
    for (const [w, sid] of Object.entries(walletSockets)) {
      if (sid === socket.id) delete walletSockets[w];
    }
    console.log('Client disconnected:', socket.id);
    io.emit('onlineCount', io.sockets.sockets.size);
  });
});

// ─── Deposit Monitor ──────────────────────────────────────────────────────────
// Cursor tracks the newest signature we've ever seen — restored from DB on startup
// so server restarts never lose progress.
let depositCursor = null;

(async () => {
  if (!db) return;
  const { data } = await db.from('processed_deposits')
    .select('signature')
    .order('created_at', { ascending: false })
    .limit(1);
  if (data?.[0]) {
    depositCursor = data[0].signature;
    console.log('[deposits] cursor restored:', depositCursor.slice(0, 12));
  }
})();

// Process a single transaction signature — credits balance if it's a valid deposit.
// Returns true if a deposit was credited.
async function processSignature(signature) {
  const already = await db.isDepositProcessed(signature);
  if (already) return false;

  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || tx.meta?.err) return false;

  const houseKey = authority.publicKey.toString();
  const rawKeys  = tx.transaction.message.accountKeys || tx.transaction.message.staticAccountKeys || [];
  const accounts = rawKeys.map(k => (typeof k.toString === 'function' ? k.toString() : String(k)));

  const houseIdx = accounts.indexOf(houseKey);
  if (houseIdx === -1) return false;

  const received = tx.meta.postBalances[houseIdx] - tx.meta.preBalances[houseIdx];
  if (received < 1_000_000) return false; // dust

  const sender = accounts[0];
  if (sender === houseKey) return false; // outgoing

  console.log(`[deposits] crediting ${(received / 1e9).toFixed(6)} SOL to ${sender.slice(0, 8)}... (${signature.slice(0, 12)})`);
  await db.recordDeposit(signature, sender, received);

  const socketId = walletSockets[sender];
  if (socketId) {
    const balance_lamports = await db.getBalance(sender);
    io.to(socketId).emit('balanceUpdate', { balance_lamports });
  }
  return true;
}

// Normal poll: only fetches signatures newer than the cursor — no limit on history.
async function monitorDeposits() {
  if (!db) return;
  try {
    const opts = { limit: 1000 };
    if (depositCursor) opts.until = depositCursor; // only fetch what's new

    const sigs = await connection.getSignaturesForAddress(authority.publicKey, opts);
    if (sigs.length === 0) return;

    // Advance cursor to the newest signature seen (deposit or not)
    depositCursor = sigs[0].signature;

    const successSigs = sigs.filter(s => !s.err);
    console.log(`[deposits] ${successSigs.length} new signatures since last check`);
    for (const { signature } of successSigs) await processSignature(signature);
  } catch (e) {
    console.error('[deposits] Monitor error:', e.message);
  }
}

// Full backfill: paginates through ALL history, stops after finding 20 consecutive
// already-processed signatures (meaning we've caught up with known history).
async function backfillDeposits() {
  if (!db) return;
  console.log('[deposits] Starting full backfill...');
  let before;
  let totalCredited = 0;
  let consecutiveProcessed = 0;

  try {
    while (true) {
      const opts = { limit: 1000 };
      if (before) opts.before = before;

      const sigs = await connection.getSignaturesForAddress(authority.publicKey, opts);
      if (sigs.length === 0) break;

      // On the very first batch, advance cursor to newest seen
      if (!before && sigs[0]) depositCursor = sigs[0].signature;

      for (const { signature, err } of sigs) {
        if (err) { consecutiveProcessed = 0; continue; }
        const credited = await processSignature(signature);
        if (credited) {
          totalCredited++;
          consecutiveProcessed = 0;
        } else {
          consecutiveProcessed++;
          // Once we hit 20 consecutive already-processed sigs we've caught up
          if (consecutiveProcessed >= 20) break;
        }
      }

      if (consecutiveProcessed >= 20 || sigs.length < 1000) break;
      before = sigs[sigs.length - 1].signature; // paginate older
    }
  } catch (e) {
    console.error('[deposits] Backfill error:', e.message);
  }

  console.log(`[deposits] Backfill complete. Credited: ${totalCredited}`);
  return totalCredited;
}

// Run immediately on startup, then every 30 seconds
monitorDeposits();
setInterval(monitorDeposits, 30_000);

// Admin endpoint: normal check, or full historical backfill with ?full=true
app.get('/api/admin/check-deposits', async (req, res) => {
  if (!ADMIN_SECRET || req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.query.full === 'true') {
    const credited = await backfillDeposits();
    return res.json({ ok: true, mode: 'backfill', credited });
  }
  await monitorDeposits();
  res.json({ ok: true, mode: 'incremental' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🚀 Crash game running at http://localhost:${PORT}`);
  console.log(`🏦 House wallet (deposit here): ${authority.publicKey.toString()}`);

  // Restore round state from DB (active bets saved before server restart)
  if (db) {
    try {
      const { data } = await db.from('active_bets').select('*');
      if (data && data.length > 0) {
        // Only consider bets placed within the last 10 minutes (prevents restoring very old stale bets)
        const cutoff = Date.now() - 10 * 60 * 1000;
        const recent = data.filter(r => new Date(r.created_at).getTime() > cutoff);
        if (recent.length > 0) {
          const savedRoundId = Math.max(...recent.map(r => r.round_id));
          game.roundId = savedRoundId;
          console.log(`[db] Resuming from round ${game.roundId} with ${recent.filter(r => r.round_id === savedRoundId).length} active bet(s)`);
        }
      }
    } catch (e) { console.error('[db] Failed to restore round state:', e.message); }
  }

  startCountdown(); // Uses game.roundId (possibly restored from DB above)

  // After startCountdown resets game.bets, re-inject the restored bets
  if (db) {
    try {
      const { data } = await db.from('active_bets').select('*');
      if (data && data.length > 0) {
        const cutoff = Date.now() - 10 * 60 * 1000;
        for (const row of data) {
          if (row.round_id === game.roundId && new Date(row.created_at).getTime() > cutoff) {
            game.bets[row.wallet] = {
              amount:      parseFloat(row.amount_sol),
              cashedOut:   false,
              autoCashOut: row.auto_cash_out ? parseFloat(row.auto_cash_out) : null,
            };
          }
        }
      }
    } catch (e) { console.error('[db] Failed to restore active bets:', e.message); }
  }
});
