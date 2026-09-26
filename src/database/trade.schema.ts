import type { TradeDirection, TradeStatus } from '../types/trade.types';

// ═══════════════════════════════════════════════
// MongoDB Document Shape — Trades Collection
// ═══════════════════════════════════════════════

/**
 * Shape of a trade document as stored in MongoDB.
 * Mirrors TradeRecord from types but includes MongoDB-specific fields.
 */
export interface TradeDocument {
  jobId: string;
  tokenMint: string;
  poolId: string;
  amountSol: number;
  direction: TradeDirection;
  status: TradeStatus;
  txSignature: string | null;
  executionPriceSol: number | null;
  slippageBps: number | null;
  priorityFeeMicroLamports: number | null;
  failureReason: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

/**
 * Factory: creates a pending trade document ready for MongoDB insertion.
 * All optional fields are initialized to null.
 */
export function createPendingTradeDocument(
  jobId: string,
  tokenMint: string,
  poolId: string,
  amountSol: number,
  direction: TradeDirection
): TradeDocument {
  return {
    jobId,
    tokenMint,
    poolId,
    amountSol,
    direction,
    status: 'PENDING_ON_CHAIN',
    txSignature: null,
    executionPriceSol: null,
    slippageBps: null,
    priorityFeeMicroLamports: null,
    failureReason: null,
    createdAt: new Date(),
    completedAt: null,
  };
}
