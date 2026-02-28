require('dotenv').config();
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors   = require('cors');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const db     = require('./db');

// ─── Optional Solana integration (if @solana/web3.js is installed) ──────────
let solanaEnabled = false;
let connection, authority, PROGRAM_ID_PK;

try {
  const web3 = require('@solana/web3.js');
  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
          SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = web3;

  const SOLANA_RPC  = process.env.SOLANA_RPC  || 'https://api.devnet.solana.com';
  const PROGRAM_ID  = process.env.PROGRAM_ID  || '';

  connection = new Connection(SOLANA_RPC, 'confirmed');

  // Load authority keypair — from env var (production) or local file (dev)
  const keypairPath = path.join(__dirname, 'authority-keypair.json');
  if (process.env.AUTHORITY_KEYPAIR) {
    authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.env.AUTHORITY_KEYPAIR)));
  } else if (fs.existsSync(keypairPath)) {
    authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(keypairPath))));
  } else {
    authority = Keypair.generate();
    fs.writeFileSync(keypairPath, JSON.stringify(Array.from(authority.secretKey)));
    console.log('🔑 New authority keypair saved to authority-keypair.json');
    console.log('   Public key:', authority.publicKey.toString());
  }

  if (PROGRAM_ID) {
    PROGRAM_ID_PK = new PublicKey(PROGRAM_ID);
    solanaEnabled = true;
    console.log('✅ Solana program integration enabled:', PROGRAM_ID);
  }

  // ─── Anchor discriminators (sha256("global:<name>")[0..8]) ──────────────
  const DISC = {};
  ['start_round','start_flying','settle_crash','cash_out','place_bet','initialize'].forEach(n => {
    DISC[n] = crypto.createHash('sha256').update('global:' + n).digest().slice(0, 8);
  });

  // ─── PDA helpers ──────────────────────────────────────────────────────────
  const HOUSE_SEED = Buffer.from('house_v1');
  const VAULT_SEED = Buffer.from('vault_v1');
  const BET_SEED   = Buffer.from('bet_v1');

  function findHousePDA()  { return PublicKey.findProgramAddressSync([HOUSE_SEED], PROGRAM_ID_PK); }
  function findVaultPDA()  { return PublicKey.findProgramAddressSync([VAULT_SEED], PROGRAM_ID_PK); }
  function findBetPDA(playerPubkey, roundId) {
    const roundBuf = Buffer.alloc(8);
    roundBuf.writeBigUInt64LE(BigInt(roundId));
    return PublicKey.findProgramAddressSync([BET_SEED, playerPubkey.toBuffer(), roundBuf], PROGRAM_ID_PK);
  }

  // ─── Robust send: retries up to maxAttempts on drop/timeout ─────────────

  // Race a promise against a ms-timeout
  function withTimeout(promise, ms, msg) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
    ]);
  }

  // Poll getSignatureStatuses until confirmed/finalized (avoids websocket hangs on public RPC)
  async function pollConfirmation(sig, timeoutMs = 90000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { value } = await withTimeout(
        connection.getSignatureStatuses([sig]),
        10000, 'getSignatureStatuses timed out'
      );
      const st = value[0];
      if (st) {
        if (st.err) throw new Error(`Tx rejected: ${JSON.stringify(st.err)}`);
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(`Tx not confirmed within ${timeoutMs / 1000}s`);
  }

  async function sendWithRetry(buildIx, signers, label, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`[tx] ${label} attempt ${attempt} — fetching blockhash...`);
        const ix = buildIx();
        const tx = new Transaction().add(ix);
        const { blockhash } = await withTimeout(
          connection.getLatestBlockhash('confirmed'),
          15000, 'getLatestBlockhash timed out'
        );
        console.log(`[tx] ${label} attempt ${attempt} — sending...`);
        tx.recentBlockhash = blockhash;
        tx.feePayer        = signers[0].publicKey;
        for (const s of signers) tx.partialSign(s);
        const raw = tx.serialize();
        const sig = await withTimeout(
          connection.sendRawTransaction(raw, { skipPreflight: true }),
          15000, 'sendRawTransaction timed out'
        );
        console.log(`[tx] ${label} attempt ${attempt} — confirming ${sig}...`);
        await pollConfirmation(sig, 90000);
        console.log(`[tx] ${label} confirmed: ${sig}`);
        return sig;
      } catch (e) {
        console.error(`[tx] ${label} attempt ${attempt}/${maxAttempts} failed: ${e.message}`);
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000));
      }
    }
    throw new Error(`${label} failed after ${maxAttempts} attempts`);
  }

  // ─── Build + send a start_round instruction ───────────────────────────────
  async function onChainStartRound(roundId, commitment) {
    if (!solanaEnabled) return;
    try {
      const [housePDA] = findHousePDA();
      const sig = await sendWithRetry(() => {
        const data = Buffer.alloc(8 + 32);
        DISC.start_round.copy(data, 0);
        Buffer.from(commitment).copy(data, 8);
        return new TransactionInstruction({
          keys: [
            { pubkey: housePDA, isSigner: false, isWritable: true },
            { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          ],
          programId: PROGRAM_ID_PK,
          data,
        });
      }, [authority], 'start_round');
      console.log(`[Round ${roundId}] start_round on-chain: ${sig}`);
    } catch (e) { console.error('start_round ultimately failed:', e.message); }
  }

  async function onChainStartFlying(roundId) {
    if (!solanaEnabled) return;
    try {
      const [housePDA] = findHousePDA();
      const sig = await sendWithRetry(() => new TransactionInstruction({
        keys: [
          { pubkey: housePDA, isSigner: false, isWritable: true },
          { pubkey: authority.publicKey, isSigner: true, isWritable: false },
        ],
        programId: PROGRAM_ID_PK,
        data: Buffer.from(DISC.start_flying),
      }), [authority], 'start_flying');
      console.log(`[Round ${roundId}] start_flying on-chain: ${sig}`);
    } catch (e) { console.error('start_flying ultimately failed:', e.message); }
  }

  async function onChainSettleCrash(roundId, crashBps, salt) {
    if (!solanaEnabled) return;
    try {
      const [housePDA] = findHousePDA();
      const sig = await sendWithRetry(() => {
        const data = Buffer.alloc(8 + 4 + 32);
        DISC.settle_crash.copy(data, 0);
        data.writeUInt32LE(crashBps, 8);
        Buffer.from(salt).copy(data, 12);
        return new TransactionInstruction({
          keys: [
            { pubkey: housePDA, isSigner: false, isWritable: true },
            { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          ],
          programId: PROGRAM_ID_PK,
          data,
        });
      }, [authority], 'settle_crash');
      console.log(`[Round ${roundId}] settle_crash on-chain @ ${crashBps/100}×: ${sig}`);
    } catch (e) { console.error('settle_crash ultimately failed:', e.message); }
  }

  // Read phase + round_id from the on-chain HouseState PDA in one call.
  // HouseState layout: 8 discriminator + 32 authority + 8 round_id + 1 phase
  //   round_id @ offset 40, phase @ offset 48
  async function getOnChainState() {
    const [housePDA] = findHousePDA();
    const info = await connection.getAccountInfo(housePDA);
    if (!info) throw new Error('House account not found on-chain');
    // HouseState layout after 8-byte discriminator:
    //   offset  8: authority Pubkey (32 bytes)
    //   offset 40: round_id u64     (8 bytes)
    //   offset 48: phase u8         (1 byte)
    const houseAuthority = new PublicKey(info.data.slice(8, 40)).toString();
    const roundId = Number(info.data.readBigUInt64LE(40));
    const phase   = info.data.readUInt8(48);
    return { houseAuthority, roundId, phase };
  }

  async function onChainForceCrash() {
    const [housePDA] = findHousePDA();
    const disc = crypto.createHash('sha256').update('global:force_crash').digest().subarray(0, 8);
    const sig = await sendWithRetry(() => new TransactionInstruction({
      keys: [
        { pubkey: housePDA,            isSigner: false, isWritable: true  },
        { pubkey: authority.publicKey, isSigner: true,  isWritable: false },
      ],
      programId: PROGRAM_ID_PK,
      data: disc,
    }), [authority], 'force_crash');
    console.log('[recovery] force_crash succeeded:', sig);
    return sig;
  }

  // Expose helpers to cashout endpoint below
  global._solana = { web3, findHousePDA, findVaultPDA, findBetPDA, getOnChainState, DISC, sendAndConfirmTransaction, sendWithRetry, authority,
    onChainStartRound, onChainStartFlying, onChainSettleCrash, onChainForceCrash };
} catch (e) {
  console.log('ℹ️  @solana/web3.js not installed — Solana features disabled. Run: npm install');
}

// ─── Express + Socket.IO ───────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '5mb' })); // 5mb for base64 profile photos

// ✅ FIX: serve index.html from project root (was pointing to missing ./public)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/docs', (_req, res) => res.sendFile(path.join(__dirname, 'docs.html')));
app.get('/disclaimer', (_req, res) => res.sendFile(path.join(__dirname, 'disclaimer.html')));

// ─── Profile API ───────────────────────────────────────────────────────────
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

// ─── REST API ──────────────────────────────────────────────────────────────
app.get('/api/state',    (req, res) => res.json({ phase: game.phase, roundId: game.roundId, multiplier: game.multiplier, countdown: game.countdown, history: game.history }));
app.get('/api/history',  (req, res) => res.json({ history: game.history }));

// Diagnostic: on-chain program state (phase + round_id)
// phases: 0=waiting 1=betting 2=flying 3=crashed
app.get('/api/onchain-status', async (_req, res) => {
  if (!solanaEnabled || !global._solana) return res.json({ enabled: false });
  try {
    const { getOnChainState } = global._solana;
    const state = await getOnChainState();
    const phaseNames = ['waiting','betting','flying','crashed'];
    const serverAuthority = authority ? authority.publicKey.toString() : null;
    res.json({
      ...state,
      phaseName:       phaseNames[state.phase] ?? 'unknown',
      serverRoundId:   game.roundId,
      serverPhase:     game.phase,
      serverAuthority,
      authorityMatch:  state.houseAuthority === serverAuthority,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/program',  (req, res) => res.json({
  programId:    process.env.PROGRAM_ID || null,
  authority:    authority ? authority.publicKey.toString() : null,
  cluster:      process.env.SOLANA_CLUSTER || 'devnet',
  rpc:          process.env.SOLANA_RPC || 'https://api.devnet.solana.com',
  enabled:      solanaEnabled,
}));

// ─── /api/prepare-bet: Server builds the PlaceBet transaction for the frontend to sign ─────
app.post('/api/prepare-bet', async (req, res) => {
  if (!solanaEnabled) return res.status(503).json({ error: 'Solana not configured' });
  const { wallet, amount, autoCashout } = req.body;
  if (!wallet || !amount) return res.status(400).json({ error: 'Missing wallet or amount' });
  if (game.phase !== 'waiting') return res.status(400).json({ error: 'Betting closed' });

  try {
    const { web3, findHousePDA, findVaultPDA, findBetPDA, getOnChainState, DISC } = global._solana;
    const { PublicKey, Transaction, TransactionInstruction, SystemProgram } = web3;

    const playerPK  = new PublicKey(wallet);
    const [housePDA]  = findHousePDA();
    const [vaultPDA]  = findVaultPDA();

    // Read on-chain state: round_id for correct PDA seeds, phase to verify betting is open.
    // game.roundId resets on server restart but house.round_id keeps incrementing,
    // so always use the on-chain value or Anchor throws ConstraintSeeds (0x7d6).
    const { roundId: onChainRoundId, phase: onChainPhase } = await getOnChainState();
    if (onChainPhase !== 1) { // 1 = PHASE_BETTING — not ready yet, tell client to retry
      return res.status(202).json({ retry: true, message: 'Round opening on-chain…' });
    }
    const [betPDA]    = findBetPDA(playerPK, onChainRoundId);

    const amountLamports  = Math.floor(amount * 1_000_000_000);
    const autoCashoutBps  = autoCashout ? Math.max(101, Math.floor(autoCashout * 100)) : 0;

    const data = Buffer.alloc(8 + 8 + 4);
    DISC.place_bet.copy(data, 0);
    data.writeBigUInt64LE(BigInt(amountLamports), 8);
    data.writeUInt32LE(autoCashoutBps, 16);

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: housePDA, isSigner: false, isWritable: true  },
        { pubkey: betPDA,   isSigner: false, isWritable: true  },
        { pubkey: vaultPDA, isSigner: false, isWritable: true  },
        { pubkey: playerPK, isSigner: true,  isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID_PK,
      data,
    });

    const tx = new Transaction().add(ix);
    const bh = await connection.getLatestBlockhash();
    tx.recentBlockhash = bh.blockhash;
    tx.feePayer = playerPK;

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    res.json({ transaction: serialized.toString('base64'), blockhash: bh.blockhash });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/cashout: Server signs + submits the CashOut tx ─────────────────
app.post('/api/cashout', async (req, res) => {
  if (!solanaEnabled) return res.status(503).json({ error: 'Solana not configured' });
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });
  if (game.phase !== 'flying') return res.status(400).json({ error: 'Game not in progress' });
  const bet = game.bets[wallet];
  if (!bet) return res.status(400).json({ error: 'No active bet' });
  if (bet.cashedOut) return res.status(400).json({ error: 'Already cashed out' });

  // Optimistic lock: mark immediately to prevent duplicate concurrent requests.
  // We snapshot the multiplier now — it won't drift while the tx confirms.
  bet.cashedOut = true;
  const snapMultiplier    = game.multiplier;
  const snapMultiplierBps = Math.floor(snapMultiplier * 100);

  try {
    const { web3, findHousePDA, findVaultPDA, findBetPDA, getOnChainState, DISC, sendWithRetry, authority } = global._solana;
    const { PublicKey, TransactionInstruction, SystemProgram } = web3;

    const playerPK     = new PublicKey(wallet);
    const [housePDA]   = findHousePDA();
    const [vaultPDA]   = findVaultPDA();
    const { roundId: onChainRoundId } = await getOnChainState();
    const [betPDA]     = findBetPDA(playerPK, onChainRoundId);

    const data = Buffer.alloc(8 + 4);
    DISC.cash_out.copy(data, 0);
    data.writeUInt32LE(snapMultiplierBps, 8);

    const sig = await sendWithRetry(() => new TransactionInstruction({
      keys: [
        { pubkey: housePDA,                isSigner: false, isWritable: true  },
        { pubkey: betPDA,                  isSigner: false, isWritable: true  },
        { pubkey: vaultPDA,                isSigner: false, isWritable: true  },
        { pubkey: playerPK,                isSigner: false, isWritable: true  },
        { pubkey: authority.publicKey,     isSigner: true,  isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID_PK,
      data,
    }), [authority], 'cash_out');

    // Finalize in-memory state using the snapshotted multiplier
    bet.cashOutAt = snapMultiplier;
    const gross   = bet.amount * snapMultiplier;
    const fee     = parseFloat((gross * CASHOUT_FEE).toFixed(6));
    bet.payout    = parseFloat((gross - fee).toFixed(6));
    totalFeesCollected += fee;
    console.log(`[fees] +${fee.toFixed(4)} SOL → ${FEE_WALLET} (total: ${totalFeesCollected.toFixed(4)} SOL)`);

    res.json({ signature: sig, multiplier: snapMultiplier, payout: bet.payout });
  } catch (e) {
    // Release the lock so the player can retry (unless it's already on-chain)
    bet.cashedOut = false;
    res.status(500).json({ error: e.message });
  }
});

// ─── Game State ────────────────────────────────────────────────────────────
let game = {
  phase: 'waiting',
  roundId: 1,
  crashPoint: 1.00,
  multiplier: 1.00,
  startTime: null,
  bets: {},
  history: [],
  countdown: 15,
  flyingInterval: null,
  countdownInterval: null,
  // Provably-fair data stored per round
  _salt: null,
  _crashBps: 0,
  _commitment: null,
};

// ─── House Edge Config ──────────────────────────────────────────────────────
const HOUSE_EDGE   = 0.01;  // 1% baked into crash point distribution
const CASHOUT_FEE  = 0.01;  // 1% fee on every cashout payout
const FEE_WALLET   = '35HsLa2JTKMaZBTNNvdfRdYQbd3FrFvFvsqSdBSDXuJC';
let   totalFeesCollected = 0; // running total (SOL) for this session

// ─── Round State Persistence (survive server restarts) ──────────────────────
const ROUND_STATE_FILE = path.join(__dirname, 'round-state.json');

function saveRoundState(roundId, crashBps, salt, commitment) {
  try {
    fs.writeFileSync(ROUND_STATE_FILE, JSON.stringify({
      roundId,
      crashBps,
      salt:       Array.from(salt),
      commitment: Array.from(commitment),
    }));
  } catch (e) { console.error('saveRoundState failed:', e.message); }
}

function loadRoundState() {
  try {
    if (!fs.existsSync(ROUND_STATE_FILE)) return null;
    const d = JSON.parse(fs.readFileSync(ROUND_STATE_FILE, 'utf8'));
    d.salt       = Buffer.from(d.salt);
    d.commitment = Buffer.from(d.commitment);
    return d;
  } catch { return null; }
}

// ─── Provably Fair ─────────────────────────────────────────────────────────
function generateCrashPoint() {
  const salt = crypto.randomBytes(32);
  const seed = `${game.roundId}-${Date.now()}-${salt.toString('hex')}`;
  const hash = crypto.createHmac('sha256', process.env.HOUSE_SECRET || 'CHANGE_ME_IN_PRODUCTION').update(seed).digest('hex');
  const h    = parseInt(hash.slice(0, 8), 16);
  const e    = Math.pow(2, 32);
  const raw  = Math.floor(((1 - HOUSE_EDGE) * 100 * e - h) / (e - h)) / 100;
  const crashPoint = Math.max(1.00, raw);
  const crashBps   = Math.floor(crashPoint * 100);

  // Compute commitment for on-chain provably-fair
  const preimage = Buffer.alloc(4 + 32);
  preimage.writeUInt32LE(crashBps, 0);
  salt.copy(preimage, 4);
  const commitment = crypto.createHash('sha256').update(preimage).digest();

  game._salt       = salt;
  game._crashBps   = crashBps;
  game._commitment = commitment;

  // Persist so we can call settle_crash after a server restart
  saveRoundState(game.roundId, crashBps, salt, commitment);

  return crashPoint;
}

// ─── Game Loop ──────────────────────────────────────────────────────────────
function startCountdown() {
  clearInterval(game.flyingInterval);
  clearInterval(game.countdownInterval);
  game.flyingInterval = null;

  game.phase      = 'waiting';
  game.bets       = {};
  game.multiplier = 1.00;
  game.countdown  = 15;
  console.log(`[round ${game.roundId}] countdown started: ${game.countdown}s`);
  game.crashPoint = generateCrashPoint();

  io.emit('phase', { phase: 'waiting', roundId: game.roundId, countdown: game.countdown });

  // Kick off on-chain start_round asynchronously (doesn't block game loop)
  if (solanaEnabled && global._solana) {
    console.log(`[on-chain] start_round queued for round ${game.roundId}`);
    (async () => {
      try { await global._solana.onChainStartRound(game.roundId, game._commitment); }
      catch (e) { console.error('[on-chain] start_round IIFE error:', e.message); }
    })();
  }

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

  if (solanaEnabled && global._solana) {
    console.log(`[on-chain] start_flying queued for round ${game.roundId}`);
    (async () => {
      try { await global._solana.onChainStartFlying(game.roundId); }
      catch (e) { console.error('[on-chain] start_flying IIFE error:', e.message); }
    })();
  }

  game.flyingInterval = setInterval(() => {
    const elapsed = (Date.now() - game.startTime) / 1000;
    game.multiplier = parseFloat(Math.pow(Math.E, 0.09 * elapsed).toFixed(2));

    // Auto-cashout check
    for (const [wallet, bet] of Object.entries(game.bets)) {
      if (!bet.cashedOut && bet.autoCashOut && game.multiplier >= bet.autoCashOut) {
        const result = processCashOut(wallet);
        if (result) {
          const socketId = walletSockets[wallet];
          if (socketId) {
            io.to(socketId).emit('cashedOut', { multiplier: result.cashOutAt, payout: result.payout, amount: result.amount });
          }
          io.emit('playerCashedOut', { wallet: wallet.slice(0,6)+'...'+wallet.slice(-4), multiplier: result.cashOutAt });
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

  for (const bet of Object.values(game.bets)) {
    if (!bet.cashedOut) bet.lost = true;
  }

  io.emit('crashed', { crashPoint: cp, history: [...game.history] });

  if (solanaEnabled && global._solana) {
    const { _crashBps, _salt, roundId } = { _crashBps: game._crashBps, _salt: game._salt, roundId: game.roundId };
    console.log(`[on-chain] settle_crash queued for round ${roundId}`);
    (async () => {
      try { await global._solana.onChainSettleCrash(roundId, _crashBps, _salt); }
      catch (e) { console.error('[on-chain] settle_crash IIFE error:', e.message); }
    })();
  }

  game.roundId++;
  setTimeout(startCountdown, 4000);
}

function processCashOut(wallet) {
  const bet = game.bets[wallet];
  if (!bet || bet.cashedOut) return null;
  bet.cashedOut  = true;
  bet.cashOutAt  = game.multiplier;
  const gross    = bet.amount * game.multiplier;
  const fee      = parseFloat((gross * CASHOUT_FEE).toFixed(6));
  bet.payout     = parseFloat((gross - fee).toFixed(6));
  totalFeesCollected += fee;
  console.log(`[fees] +${fee.toFixed(4)} SOL → ${FEE_WALLET} (total: ${totalFeesCollected.toFixed(4)} SOL)`);
  return bet;
}

// ─── Socket.IO ─────────────────────────────────────────────────────────────
const walletSockets = {};

// ─── Chat ─────────────────────────────────────────────────────────────────────
const chatHistory = [];

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

  socket.emit('init', {
    phase:      game.phase,
    roundId:    game.roundId,
    multiplier: game.multiplier,
    countdown:  game.countdown,
    history:    [...game.history],
  });

  if (chatHistory.length > 0) socket.emit('chatHistory', chatHistory);
  io.emit('onlineCount', io.sockets.sockets.size);

  socket.on('register', ({ wallet }) => {
    if (!wallet) return;
    walletSockets[wallet] = socket.id;
    if (db) db.from('users').upsert({ wallet, last_seen: new Date().toISOString() }, { onConflict: 'wallet', ignoreDuplicates: false }).then(() => {});
  });

  socket.on('placeBet', ({ wallet, amount, autoCashOut }) => {
    if (!wallet)  return socket.emit('betError', 'No wallet provided.');
    amount = parseFloat(amount);
    if (!amount || amount <= 0 || isNaN(amount)) return socket.emit('betError', 'Invalid amount.');
    if (game.phase !== 'waiting')  return socket.emit('betError', 'Betting is closed. Wait for next round.');
    if (game.bets[wallet])         return socket.emit('betError', 'Bet already placed this round.');

    game.bets[wallet] = {
      amount,
      cashedOut:   false,
      autoCashOut: autoCashOut && parseFloat(autoCashOut) >= 1.01 ? parseFloat(autoCashOut) : null,
    };

    socket.emit('betConfirmed', { amount, autoCashOut: game.bets[wallet].autoCashOut });
    if (db) db.rpc('track_bet', { p_wallet: wallet }).then(() => {});
    io.emit('betPlaced', { wallet: wallet.slice(0,6)+'...'+wallet.slice(-4), amount });
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
    io.emit('playerCashedOut', { wallet: wallet.slice(0,6)+'...'+wallet.slice(-4), multiplier: result.cashOutAt });
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

// ─── Admin: diagnose start_round failures ────────────────────────────────────
// GET /api/admin/diagnose — simulates start_round and reports the exact error
app.get('/api/admin/diagnose', async (_req, res) => {
  if (!solanaEnabled || !global._solana) return res.status(503).json({ error: 'Solana not enabled' });
  try {
    const { web3, findHousePDA, getOnChainState, DISC, authority } = global._solana;
    const { Transaction, TransactionInstruction } = web3;
    const [housePDA] = findHousePDA();

    const [balance, state] = await Promise.all([
      connection.getBalance(authority.publicKey),
      getOnChainState(),
    ]);

    // Build a start_round tx with a dummy commitment just to simulate it
    const data = Buffer.alloc(8 + 32);
    DISC.start_round.copy(data, 0);
    // dummy commitment — simulation will fail on phase check before hash check
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: housePDA,            isSigner: false, isWritable: true  },
        { pubkey: authority.publicKey, isSigner: true,  isWritable: false },
      ],
      programId: PROGRAM_ID_PK,
      data,
    });
    const tx = new Transaction().add(ix);
    const bh = await connection.getLatestBlockhash();
    tx.recentBlockhash = bh.blockhash;
    tx.feePayer = authority.publicKey;
    tx.sign(authority);

    const sim = await connection.simulateTransaction(tx);

    res.json({
      authorityBalance: (balance / 1e9).toFixed(6) + ' SOL',
      onChainState: state,
      simulation: {
        err:  sim.value.err,
        logs: sim.value.logs,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin: force-crash (recover from stuck FLYING state) ───────────────────
// Call once when /api/onchain-status shows phaseName = "flying" or "betting"
// after a server restart that lost the original salt.
app.post('/api/admin/force-crash', async (_req, res) => {
  if (!solanaEnabled || !global._solana) return res.status(503).json({ error: 'Solana not enabled' });
  try {
    const { web3, findHousePDA, sendWithRetry, authority } = global._solana;
    const { TransactionInstruction } = web3;
    const [housePDA] = findHousePDA();

    // Discriminator for force_crash = sha256("global:force_crash")[0..8]
    const disc = crypto.createHash('sha256').update('global:force_crash').digest().subarray(0, 8);
    const sig = await sendWithRetry(() => new TransactionInstruction({
      keys: [
        { pubkey: housePDA,              isSigner: false, isWritable: true  },
        { pubkey: authority.publicKey,   isSigner: true,  isWritable: false },
      ],
      programId: PROGRAM_ID_PK,
      data: disc,
    }), [authority], 'force_crash');
    console.log('[admin] force_crash succeeded:', sig);
    res.json({ ok: true, signature: sig });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin: withdraw house profits from the vault ────────────────────────────
// POST /api/admin/withdraw  body: { amount: <SOL as float> }
// SOL is always forwarded to WITHDRAW_DESTINATION — no other address is possible.
const WITHDRAW_DESTINATION = 'DjGYTPqUvFvCMR3qneDN3dBg6EezeRF5ssj2T7turi4d';

app.post('/api/admin/withdraw', async (req, res) => {
  if (!solanaEnabled || !global._solana) return res.status(503).json({ error: 'Solana not enabled' });
  const amountSol = parseFloat(req.body.amount);
  if (!amountSol || amountSol <= 0) return res.status(400).json({ error: 'amount (SOL) required' });

  try {
    const { web3, findHousePDA, findVaultPDA, sendWithRetry, authority } = global._solana;
    const { TransactionInstruction, SystemProgram, PublicKey } = web3;
    const [housePDA] = findHousePDA();
    const [vaultPDA] = findVaultPDA();
    const destPK     = new PublicKey(WITHDRAW_DESTINATION);

    const amountLamports = BigInt(Math.floor(amountSol * 1_000_000_000));

    // Step 1: on-chain withdraw — vault → authority (contract enforces escrowed-balance check)
    const disc = crypto.createHash('sha256').update('global:withdraw').digest().subarray(0, 8);
    const data = Buffer.alloc(8 + 8);
    disc.copy(data, 0);
    data.writeBigUInt64LE(amountLamports, 8);

    const sig1 = await sendWithRetry(() => new TransactionInstruction({
      keys: [
        { pubkey: housePDA,                isSigner: false, isWritable: false },
        { pubkey: vaultPDA,                isSigner: false, isWritable: true  },
        { pubkey: authority.publicKey,     isSigner: true,  isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID_PK,
      data,
    }), [authority], 'withdraw-vault-to-authority');

    // Step 2: native transfer — authority → WITHDRAW_DESTINATION
    const sig2 = await sendWithRetry(
      () => SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: destPK, lamports: amountLamports }),
      [authority], 'withdraw-forward-to-destination'
    );

    console.log(`[admin] withdraw ${amountSol} SOL → ${WITHDRAW_DESTINATION}: ${sig2}`);
    res.json({ ok: true, withdrawn_sol: amountSol, destination: WITHDRAW_DESTINATION,
               sig_vault_to_authority: sig1, sig_to_destination: sig2 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── On-chain startup recovery ───────────────────────────────────────────────
// If the server was killed while a round was flying, the on-chain program
// gets stuck in PHASE_FLYING.  We try to settle it using the persisted
// round-state.json; if that file matches the on-chain round we settle normally,
// otherwise we warn the operator to call /api/admin/force-crash manually.
async function recoverOnChainState() {
  if (!solanaEnabled || !global._solana) return;
  const { getOnChainState } = global._solana;
  try {
    const { phase, roundId } = await getOnChainState();
    const phaseNames = ['waiting','betting','flying','crashed'];
    console.log(`[recovery] On-chain: phase=${phaseNames[phase]??phase} roundId=${roundId}`);

    if (phase === 2) { // PHASE_FLYING — need settle_crash first
      const saved = loadRoundState();
      if (saved && Number(saved.roundId) === roundId) {
        console.log('[recovery] Settling stuck round using saved state...');
        await global._solana.onChainSettleCrash(saved.roundId, saved.crashBps, saved.salt);
        console.log('[recovery] settle_crash OK');
      } else {
        console.warn('[recovery] ⚠️  On-chain is FLYING, no saved state — calling force_crash automatically...');
        await global._solana.onChainForceCrash();
        console.log('[recovery] force_crash OK — on-chain is now CRASHED, game loop can proceed');
      }
    } else if (phase === 1) { // PHASE_BETTING — start_flying was never called; settle it
      const saved = loadRoundState();
      if (saved && Number(saved.roundId) === roundId) {
        console.log('[recovery] On-chain is BETTING; starting flying then settling...');
        await global._solana.onChainStartFlying(saved.roundId);
        await global._solana.onChainSettleCrash(saved.roundId, saved.crashBps, saved.salt);
        console.log('[recovery] Recovered from BETTING phase');
      }
    }
  } catch (e) {
    console.error('[recovery] Failed:', e.message);
  }
}

// ─── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🚀 Crash game running at http://localhost:${PORT}`);
  if (authority) console.log(`🔑 Authority: ${authority.publicKey.toString()}`);
  await recoverOnChainState();
  startCountdown();
});
