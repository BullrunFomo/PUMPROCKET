use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

declare_id!("Dd83VweBXiCMN8fBefvR56aFkDXtfyCJPL2XGpNEmVM1");

// ─── Seeds ────────────────────────────────────────────────────────────────────
pub const HOUSE_SEED: &[u8] = b"house_v1";
pub const VAULT_SEED: &[u8] = b"vault_v1";
pub const BET_SEED:   &[u8] = b"bet_v1";

// ─── Game Phases ──────────────────────────────────────────────────────────────
pub const PHASE_WAITING: u8 = 0;
pub const PHASE_BETTING: u8 = 1;
pub const PHASE_FLYING:  u8 = 2;
pub const PHASE_CRASHED: u8 = 3;

// ─── Limits ───────────────────────────────────────────────────────────────────
/// Minimum single bet: 0.001 SOL
pub const MIN_BET_LAMPORTS: u64 = 1_000_000;
/// Maximum single bet: 10 SOL — prevents vault insolvency from one large bet
pub const MAX_BET_LAMPORTS: u64 = 10_000_000_000;
/// Maximum multiplier the authority may approve for a cash-out: 10,000× (1,000,000 bps)
/// Bounds the worst-case loss from a compromised authority key.
pub const MAX_CASHOUT_BPS: u32 = 1_000_000;
/// If a round is still open after this many seconds, players may self-refund (24 h)
pub const MAX_ROUND_SECS: i64 = 86_400;

#[program]
pub mod crash_game {
    use super::*;

    /// One-time setup: create the HouseState PDA and optionally fund the vault.
    /// Call this once after deploying with the authority keypair.
    pub fn initialize(ctx: Context<Initialize>, initial_vault_lamports: u64) -> Result<()> {
        let house = &mut ctx.accounts.house;
        house.authority        = ctx.accounts.authority.key();
        house.round_id         = 0;
        house.phase            = PHASE_WAITING;
        house.crash_commitment = [0u8; 32];
        house.last_crash_bps   = 100; // 1.00×
        house.bump             = ctx.bumps.house;
        house.vault_bump       = ctx.bumps.vault;
        house.total_escrowed   = 0;
        house.refunds_enabled  = false;
        house.refund_round_id  = 0;
        house.round_started_at = 0;

        if initial_vault_lamports > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to:   ctx.accounts.vault.to_account_info(),
                    },
                ),
                initial_vault_lamports,
            )?;
        }
        Ok(())
    }

    /// Add SOL liquidity to the house vault so it can cover payouts.
    pub fn fund_vault(ctx: Context<FundVault>, amount: u64) -> Result<()> {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to:   ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    /// Authority opens a new betting round and commits to the crash point.
    /// commitment = sha256(crash_point_bps_le4 || salt32)
    /// This prevents the house from changing the crash point after bets are placed.
    pub fn start_round(ctx: Context<AuthorityAction>, crash_commitment: [u8; 32]) -> Result<()> {
        let house = &mut ctx.accounts.house;
        require!(
            house.phase == PHASE_WAITING || house.phase == PHASE_CRASHED,
            CrashError::InvalidPhase
        );
        // Use checked_add so an overflow produces an error instead of wrapping silently.
        house.round_id         = house.round_id.checked_add(1).ok_or(CrashError::Overflow)?;
        house.crash_commitment = crash_commitment;
        house.phase            = PHASE_BETTING;
        house.round_started_at = Clock::get()?.unix_timestamp;
        // Reset escrow counter. Any leftover from a force_crash window that closed
        // without all players claiming is intentionally forfeited here.
        house.total_escrowed   = 0;
        house.refunds_enabled  = false;

        emit!(RoundStarted { round_id: house.round_id });
        Ok(())
    }

    /// Authority closes betting and starts the multiplier flying.
    pub fn start_flying(ctx: Context<AuthorityAction>) -> Result<()> {
        let house = &mut ctx.accounts.house;
        require!(house.phase == PHASE_BETTING, CrashError::InvalidPhase);
        house.phase = PHASE_FLYING;

        emit!(FlyingStarted { round_id: house.round_id });
        Ok(())
    }

    /// Player locks SOL into a per-(player, round_id) escrow PDA.
    ///
    /// Note: `auto_cashout_bps` is stored on-chain for transparency but is
    /// enforced off-chain by the server. It is NOT verified here.
    pub fn place_bet(
        ctx:              Context<PlaceBet>,
        amount_lamports:  u64,
        auto_cashout_bps: u32, // 0 = disabled; informational only
    ) -> Result<()> {
        require!(amount_lamports >= MIN_BET_LAMPORTS, CrashError::BetTooSmall);
        require!(amount_lamports <= MAX_BET_LAMPORTS, CrashError::BetTooLarge);

        let round_id = {
            let house = &ctx.accounts.house;
            require!(house.phase == PHASE_BETTING, CrashError::BettingClosed);
            house.round_id
        };

        let bet = &mut ctx.accounts.player_bet;
        bet.player           = ctx.accounts.player.key();
        bet.round_id         = round_id;
        bet.amount           = amount_lamports;
        bet.auto_cashout_bps = if auto_cashout_bps >= 101 { auto_cashout_bps } else { 0 };
        bet.cashed_out       = false;
        bet.payout           = 0;
        bet.bump             = ctx.bumps.player_bet;

        // Track total player funds in vault so withdraw() cannot drain them.
        ctx.accounts.house.total_escrowed = ctx.accounts.house.total_escrowed
            .checked_add(amount_lamports)
            .ok_or(CrashError::Overflow)?;

        // Transfer SOL: player → vault
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.player.to_account_info(),
                    to:   ctx.accounts.vault.to_account_info(),
                },
            ),
            amount_lamports,
        )?;

        emit!(BetPlaced {
            player:   bet.player,
            round_id,
            amount:   amount_lamports,
        });
        Ok(())
    }

    /// Authority approves a player cash-out at the given multiplier.
    ///
    /// Security notes:
    ///   - `multiplier_bps` is capped at MAX_CASHOUT_BPS (10,000×) to bound
    ///     the damage a compromised authority key can do.
    ///   - The phase check ensures cash-outs cannot happen after the crash.
    ///   - State is updated (cashed_out = true) before the SOL transfer
    ///     to prevent reentrancy.
    pub fn cash_out(ctx: Context<CashOut>, multiplier_bps: u32) -> Result<()> {
        require!(multiplier_bps >= 101,           CrashError::InvalidMultiplier); // >= 1.01×
        require!(multiplier_bps <= MAX_CASHOUT_BPS, CrashError::MultiplierTooHigh);

        {
            let house = &ctx.accounts.house;
            require!(house.phase == PHASE_FLYING, CrashError::InvalidPhase);
        }

        let (amount, round_id) = {
            let bet = &ctx.accounts.player_bet;
            require!(!bet.cashed_out, CrashError::AlreadyCashedOut);
            require!(
                bet.round_id == ctx.accounts.house.round_id,
                CrashError::WrongRound
            );
            (bet.amount, bet.round_id)
        };

        let payout = (amount as u128)
            .checked_mul(multiplier_bps as u128)
            .ok_or(CrashError::Overflow)?
            .checked_div(100)
            .ok_or(CrashError::Overflow)? as u64;

        // Mark cashed-out BEFORE transferring (reentrancy guard).
        {
            let bet = &mut ctx.accounts.player_bet;
            bet.cashed_out = true;
            bet.payout     = payout;
        }

        // Player's original stake is no longer in escrow.
        ctx.accounts.house.total_escrowed = ctx.accounts.house.total_escrowed
            .saturating_sub(amount);

        // Transfer SOL: vault → player  (vault is a PDA, signed with seeds)
        let vault_bump = ctx.accounts.house.vault_bump;
        let seeds      = &[VAULT_SEED, &[vault_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to:   ctx.accounts.player.to_account_info(),
                },
                &[seeds],
            ),
            payout,
        )?;

        emit!(CashedOut {
            player: ctx.accounts.player_bet.player,
            round_id,
            multiplier_bps,
            payout,
        });
        Ok(())
    }

    /// Authority reveals the crash point and ends the flying phase.
    /// Verifies sha256(crash_bps_le4 || salt) == crash_commitment (provably fair).
    /// Bets not cashed out are forfeited to the vault.
    pub fn settle_crash(
        ctx:       Context<AuthorityAction>,
        crash_bps: u32,      // e.g. 142 = 1.42×
        salt:      [u8; 32],
    ) -> Result<()> {
        let house = &mut ctx.accounts.house;
        require!(house.phase == PHASE_FLYING, CrashError::InvalidPhase);

        // Verify commit-reveal (provably fair)
        let mut preimage = crash_bps.to_le_bytes().to_vec();
        preimage.extend_from_slice(&salt);
        let hash = anchor_lang::solana_program::hash::hash(&preimage);
        require!(
            hash.to_bytes() == house.crash_commitment,
            CrashError::InvalidCrashProof
        );

        house.phase          = PHASE_CRASHED;
        house.last_crash_bps = crash_bps;
        // Remaining uncashed bets are forfeited to the vault; clear the escrow counter.
        house.total_escrowed = 0;

        emit!(RoundCrashed { round_id: house.round_id, crash_bps });
        Ok(())
    }

    /// Emergency: authority forces CRASHED state without the hash proof.
    /// Use only to recover from a server failure that lost the salt before
    /// settle_crash could run.
    ///
    /// Unlike settle_crash, this enables refunds so players are not punished
    /// for a server-side failure. A distinct ForceCrashed event is emitted
    /// so indexers can distinguish it from a provably-fair crash.
    pub fn force_crash(ctx: Context<AuthorityAction>) -> Result<()> {
        let house = &mut ctx.accounts.house;
        require!(
            house.phase == PHASE_FLYING || house.phase == PHASE_BETTING,
            CrashError::InvalidPhase
        );
        house.phase           = PHASE_CRASHED;
        house.refunds_enabled = true;
        house.refund_round_id = house.round_id;
        // total_escrowed is intentionally NOT cleared here; it will be
        // decremented as each player calls claim_refund.

        emit!(ForceCrashed { round_id: house.round_id });
        Ok(())
    }

    /// Player reclaims their bet in full after a force_crash or a timed-out round.
    ///
    /// Eligible when EITHER:
    ///   (a) force_crash was called for this exact round, OR
    ///   (b) the round has been open for > MAX_ROUND_SECS without settling.
    ///
    /// The player must sign, and they can only refund their own bet.
    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        let clock = Clock::get()?;
        let house = &ctx.accounts.house;

        let timed_out = clock.unix_timestamp
            .saturating_sub(house.round_started_at)
            > MAX_ROUND_SECS;

        let forced = house.refunds_enabled
            && ctx.accounts.player_bet.round_id == house.refund_round_id;

        require!(forced || timed_out, CrashError::RefundsNotEnabled);
        require!(!ctx.accounts.player_bet.cashed_out, CrashError::AlreadyCashedOut);
        // Bet must belong to the stuck/forced round (or the current round on timeout).
        require!(
            ctx.accounts.player_bet.round_id == house.round_id
                || ctx.accounts.player_bet.round_id == house.refund_round_id,
            CrashError::WrongRound
        );

        let amount   = ctx.accounts.player_bet.amount;
        let round_id = ctx.accounts.player_bet.round_id;

        // Mark refunded BEFORE transferring (reentrancy guard).
        {
            let bet        = &mut ctx.accounts.player_bet;
            bet.cashed_out = true;
            bet.payout     = amount; // full refund
        }

        ctx.accounts.house.total_escrowed = ctx.accounts.house.total_escrowed
            .saturating_sub(amount);

        let vault_bump = ctx.accounts.house.vault_bump;
        let seeds      = &[VAULT_SEED, &[vault_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to:   ctx.accounts.player.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        emit!(RefundClaimed {
            player: ctx.accounts.player_bet.player,
            round_id,
            amount,
        });
        Ok(())
    }

    /// Authority withdraws house profit from the vault.
    /// Enforces that the withdrawal cannot touch funds that are still held
    /// in player escrow (total_escrowed).
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let vault_lamports = ctx.accounts.vault.lamports();
        let escrowed       = ctx.accounts.house.total_escrowed;
        require!(
            vault_lamports.saturating_sub(escrowed) >= amount,
            CrashError::InsufficientFreeBalance
        );

        let vault_bump = ctx.accounts.house.vault_bump;
        let seeds      = &[VAULT_SEED, &[vault_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to:   ctx.accounts.authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }
}

// ─── Account Contexts ─────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + HouseState::LEN,
        seeds = [HOUSE_SEED],
        bump,
    )]
    pub house: Account<'info, HouseState>,

    /// CHECK: PDA vault — holds player bets and house liquidity as raw SOL
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump,
    )]
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundVault<'info> {
    #[account(seeds = [HOUSE_SEED], bump = house.bump, has_one = authority)]
    pub house: Account<'info, HouseState>,

    /// CHECK: PDA vault
    #[account(mut, seeds = [VAULT_SEED], bump = house.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AuthorityAction<'info> {
    #[account(
        mut,
        seeds   = [HOUSE_SEED],
        bump    = house.bump,
        has_one = authority,
    )]
    pub house:     Account<'info, HouseState>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    // mut because place_bet increments house.total_escrowed
    #[account(mut, seeds = [HOUSE_SEED], bump = house.bump)]
    pub house: Account<'info, HouseState>,

    #[account(
        init,
        payer = player,
        space = 8 + PlayerBet::LEN,
        seeds = [BET_SEED, player.key().as_ref(), &house.round_id.to_le_bytes()],
        bump,
    )]
    pub player_bet: Account<'info, PlayerBet>,

    /// CHECK: PDA vault receives the bet SOL
    #[account(mut, seeds = [VAULT_SEED], bump = house.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CashOut<'info> {
    // mut because cash_out decrements house.total_escrowed
    #[account(mut, seeds = [HOUSE_SEED], bump = house.bump, has_one = authority)]
    pub house: Account<'info, HouseState>,

    #[account(
        mut,
        seeds = [BET_SEED, player_bet.player.as_ref(), &player_bet.round_id.to_le_bytes()],
        bump  = player_bet.bump,
    )]
    pub player_bet: Account<'info, PlayerBet>,

    /// CHECK: PDA vault pays out the winner
    #[account(mut, seeds = [VAULT_SEED], bump = house.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: Recipient verified against player_bet.player
    #[account(mut, address = player_bet.player @ CrashError::WrongPlayer)]
    pub player: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    // mut because claim_refund decrements house.total_escrowed
    #[account(mut, seeds = [HOUSE_SEED], bump = house.bump)]
    pub house: Account<'info, HouseState>,

    #[account(
        mut,
        seeds = [BET_SEED, player.key().as_ref(), &player_bet.round_id.to_le_bytes()],
        bump  = player_bet.bump,
    )]
    pub player_bet: Account<'info, PlayerBet>,

    /// CHECK: PDA vault pays out the refund
    #[account(mut, seeds = [VAULT_SEED], bump = house.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    // The player must sign and must be the original bettor.
    #[account(mut, constraint = player.key() == player_bet.player @ CrashError::WrongPlayer)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(seeds = [HOUSE_SEED], bump = house.bump, has_one = authority)]
    pub house: Account<'info, HouseState>,

    /// CHECK: PDA vault
    #[account(mut, seeds = [VAULT_SEED], bump = house.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ─── Account Data ─────────────────────────────────────────────────────────────

#[account]
pub struct HouseState {
    pub authority:        Pubkey,    // 32  — the server's keypair
    pub round_id:         u64,       //  8
    pub phase:            u8,        //  1  (0=waiting 1=betting 2=flying 3=crashed)
    pub crash_commitment: [u8; 32],  // 32  — sha256(crash_bps_le4 || salt32)
    pub last_crash_bps:   u32,       //  4  — e.g. 234 = 2.34×
    pub bump:             u8,        //  1
    pub vault_bump:       u8,        //  1
    // ── security fields (fit in the 48-byte reserved block) ─────────────────
    pub total_escrowed:   u64,       //  8  — sum of all active player bets in vault
    pub refunds_enabled:  bool,      //  1  — true after force_crash
    pub refund_round_id:  u64,       //  8  — round that was force_crash'd
    pub round_started_at: i64,       //  8  — unix timestamp of last start_round
    // Totals: 32+8+1+32+4+1+1+8+1+8+8 = 104 bytes; LEN=128 leaves 24 bytes spare.
}
impl HouseState {
    pub const LEN: usize = 128;
}

#[account]
pub struct PlayerBet {
    pub player:           Pubkey,  // 32
    pub round_id:         u64,     //  8
    pub amount:           u64,     //  8  lamports
    pub auto_cashout_bps: u32,     //  4  0 = disabled; stored for off-chain use only
    pub cashed_out:       bool,    //  1
    pub payout:           u64,     //  8  lamports received (0 until cashout/refund)
    pub bump:             u8,      //  1
    // 32+8+8+4+1+8+1 = 62 bytes; pad to 96
}
impl PlayerBet {
    pub const LEN: usize = 96;
}

// ─── Events ───────────────────────────────────────────────────────────────────

#[event] pub struct RoundStarted  { pub round_id: u64 }
#[event] pub struct FlyingStarted { pub round_id: u64 }

#[event]
pub struct BetPlaced {
    pub player:   Pubkey,
    pub round_id: u64,
    pub amount:   u64,
}

#[event]
pub struct CashedOut {
    pub player:         Pubkey,
    pub round_id:       u64,
    pub multiplier_bps: u32,
    pub payout:         u64,
}

#[event]
pub struct RoundCrashed {
    pub round_id:  u64,
    pub crash_bps: u32,
}

/// Emitted exclusively by force_crash — indexers should treat this differently
/// from RoundCrashed because the crash_commitment was NOT verified.
#[event]
pub struct ForceCrashed {
    pub round_id: u64,
}

#[event]
pub struct RefundClaimed {
    pub player:   Pubkey,
    pub round_id: u64,
    pub amount:   u64,
}

// ─── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum CrashError {
    #[msg("Wrong game phase for this instruction")]
    InvalidPhase,
    #[msg("Betting is closed — wait for next round")]
    BettingClosed,
    #[msg("Minimum bet is 0.001 SOL")]
    BetTooSmall,
    #[msg("Bet exceeds the per-player maximum of 10 SOL")]
    BetTooLarge,
    #[msg("Already cashed out this round")]
    AlreadyCashedOut,
    #[msg("Bet belongs to a different round")]
    WrongRound,
    #[msg("Payout recipient does not match the bet")]
    WrongPlayer,
    #[msg("Multiplier must be >= 1.01× (101 bps)")]
    InvalidMultiplier,
    #[msg("Multiplier exceeds the on-chain maximum of 10,000×")]
    MultiplierTooHigh,
    #[msg("Crash point does not match the committed hash")]
    InvalidCrashProof,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Refunds are not enabled for this round")]
    RefundsNotEnabled,
    #[msg("Withdrawal would dip into player escrow funds")]
    InsufficientFreeBalance,
}
