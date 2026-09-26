import { PublicKey } from '@solana/web3.js';

// ═══════════════════════════════════════════════
// Immutable On-Chain Protocol Addresses
// ═══════════════════════════════════════════════

/** Raydium AMM V4 Program ID — routes all swap instructions */
export const RAYDIUM_V4_PROGRAM_ID = new PublicKey(
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
);

/** Wrapped SOL Mint — native SOL representation as SPL token */
export const WSOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112'
);

/** Target sample token mint (TIFFANY) — for initial development & testing */
export const TARGET_TOKEN_MINT = new PublicKey(
  'SaPFjDCz4bcrqVkU6JWjskJftp9jENNxP5T9Ur1pump'
);

// ═══════════════════════════════════════════════
// Solana Network Constants
// ═══════════════════════════════════════════════

/** Number of lamports per SOL (1 SOL = 1e9 lamports) */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Solana commitment level for transaction confirmation */
export const SOLANA_COMMITMENT = 'confirmed' as const;

// ═══════════════════════════════════════════════
// BullMQ Queue Identifiers
// ═══════════════════════════════════════════════

/** Primary execution queue name — all swap jobs flow through this */
export const PREDATOR_QUEUE_NAME = 'PredatorExecutionQueue';

/** Job type identifier for swap operations */
export const SWAP_JOB_NAME = 'PredatorSwapJob';

// ═══════════════════════════════════════════════
// Compute Budget Defaults
// ═══════════════════════════════════════════════

/** Maximum compute units allocated per swap transaction */
export const COMPUTE_UNIT_LIMIT = 200_000;

/** Micro-lamports per compute unit for priority fee escalation */
export const DEFAULT_PRIORITY_FEE_MICROLAMPORTS = 50_000;
