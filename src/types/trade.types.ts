// ═══════════════════════════════════════════════
// Trade Direction & Status
// ═══════════════════════════════════════════════

/** Swap direction — BUY acquires token with SOL, SELL dumps token for SOL */
export type TradeDirection = 'BUY' | 'SELL';

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
  readonly amountSol: number;
  readonly direction: TradeDirection;
  readonly detectedAt: number; // Unix timestamp ms — radar detection time
}

// ═══════════════════════════════════════════════
// Trade Record — MongoDB Document Shape
// ═══════════════════════════════════════════════

/** Full trade document persisted in the `trades` collection */
export interface TradeRecord {
  readonly jobId: string;
  readonly tokenMint: string;
  readonly poolId: string;
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
