// ═══════════════════════════════════════════════
// Trade Direction & Status
// ═══════════════════════════════════════════════

/** Swap direction — BUY acquires token with SOL, SELL dumps token for SOL */
export type TradeDirection = 'BUY' | 'SELL';

/**
 * Execution venue — determines which on-chain program handles the swap:
 *   raydium  → Raydium AMM V4 pools
 *   pumpfun  → Pump.fun bonding curve (pre-graduation)
 *   pumpswap → PumpSwap AMM pools (graduated tokens)
 */
export type VenueType = 'raydium' | 'pumpfun' | 'pumpswap';

/** Trade lifecycle status tracked in MongoDB */
export type TradeStatus =
  | 'PENDING_ON_CHAIN'
  | 'COMPLETED'
  | 'FAILED'
  | 'RETRYING';

// ═══════════════════════════════════════════════
// Trade Payload — BullMQ Job Data
// ═══════════════════════════════════════════════

/** Schema for jobs enqueued into the PredatorExecutionQueue */
export interface TradePayload {
  readonly tokenMint: string;
  readonly poolId: string;
  readonly venue: VenueType;
  readonly amountSol: number;
  readonly direction: TradeDirection;
  readonly detectedAt: number; // Unix timestamp ms — radar detection time
  /** SELL-ALL mode: ignore amountSol notional, sell entire ATA balance. */
  readonly sellAll?: boolean;
  /** BUY-MAX mode: ignore amountSol, spend entire SOL balance minus fee reserve. */
  readonly buyMax?: boolean;
  /** Order type: MARKET executes immediately, LIMIT executes only if price condition met */
  readonly orderType?: 'MARKET' | 'LIMIT';
  /** Limit price in SOL per token, required for LIMIT orders */
  readonly limitPrice?: number;
}

// ═══════════════════════════════════════════════
// Trade Record — MongoDB Document Shape
// ═══════════════════════════════════════════════

/** Full trade document persisted in the `trades` collection */
export interface TradeRecord {
  readonly jobId: string;
  readonly tokenMint: string;
  readonly poolId: string;
  readonly venue: VenueType;
  readonly amountSol: number;
  readonly direction: TradeDirection;
  readonly status: TradeStatus;
  readonly txSignature: string | null;
  readonly executionPriceSol: number | null;
  readonly slippageBps: number | null;
  readonly priorityFeeMicroLamports: number | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}
