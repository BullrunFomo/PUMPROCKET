# Crash.IO — Setup & Deploy

## 1. Install server dependencies
```bash
npm install
```

## 2. Run the game (off-chain demo mode — works immediately)
```bash
npm start
# Open http://localhost:3000
```
The game runs fully off-chain. Connect wallet shows a demo wallet.
Install **Phantom** browser extension to use a real Solana wallet.

---

## 3. Deploy the Solana smart contract (on-chain real-money mode)

### Prerequisites
```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/v1.18.17/install)"

# Install Anchor CLI
npm install -g @coral-xyz/anchor-cli@0.29.0
```

### Build & deploy
```bash
cd program

# Build the program
anchor build

# This prints the program ID — copy it!
anchor keys list

# Update the program ID in TWO places:
#   program/programs/crash_game/src/lib.rs  → declare_id!("YOUR_ID_HERE")
#   program/Anchor.toml                     → crash_game = "YOUR_ID_HERE"

# Re-build with the correct ID
anchor build

# Deploy to devnet (costs ~2 SOL for rent)
anchor deploy --provider.cluster devnet
```

### Fund the house vault
```bash
# The server auto-generates authority-keypair.json on first run.
# Get its public key:
node -e "const k=require('./authority-keypair.json'); const {Keypair}=require('@solana/web3.js'); console.log(Keypair.fromSecretKey(new Uint8Array(k)).publicKey.toString())"

# Airdrop devnet SOL to the authority
solana airdrop 5 <AUTHORITY_PUBLIC_KEY> --url devnet

# Initialize the program (run once)
node -e "
const anchor = require('@coral-xyz/anchor');
const {Connection,Keypair,PublicKey} = require('@solana/web3.js');
// ... or use: anchor run initialize
"
```

### Configure the server
```bash
# Set environment variables before starting
export PROGRAM_ID="YOUR_DEPLOYED_PROGRAM_ID"
export SOLANA_RPC="https://api.devnet.solana.com"
export SOLANA_CLUSTER="devnet"
export HOUSE_SECRET="your-random-secret-here"  # for provably-fair hash

npm start
```

The badge in the UI will switch from **"Off-chain mode"** to **"On-chain — devnet"**
when Phantom is connected and the program is configured.

---

## Architecture

```
Browser (Phantom)          Server (Node.js)           Solana
     │                          │                        │
     │  Socket.IO (real-time)   │                        │
     │◄────────────────────────►│                        │
     │                          │                        │
     │  POST /api/prepare-bet   │                        │
     │─────────────────────────►│ builds PlaceBet tx     │
     │◄─────────────────────────│ (unsigned)             │
     │  Phantom signs tx        │                        │
     │──────────────────────────┼───────────────────────►│
     │                          │                        │ place_bet ix
     │  POST /api/cashout       │                        │
     │─────────────────────────►│ builds+signs CashOut   │
     │                          │────────────────────────►│
     │                          │                        │ cash_out ix
     │  Socket cashedOut event  │                        │
     │◄─────────────────────────│                        │
```

## Smart contract instructions

| Instruction    | Caller    | Description                                    |
|---------------|-----------|------------------------------------------------|
| `initialize`   | Authority | One-time setup, funds vault                    |
| `fund_vault`   | Authority | Add house liquidity                            |
| `start_round`  | Authority | Opens betting, commits to crash point          |
| `start_flying` | Authority | Closes betting, multiplier starts climbing     |
| `place_bet`    | Player    | Locks SOL in escrow PDA                        |
| `cash_out`     | Authority | Pays out winner at current multiplier          |
| `settle_crash` | Authority | Reveals crash point (provably fair), ends round|
| `withdraw`     | Authority | House withdraws profits                        |
