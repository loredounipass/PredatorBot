// ═══════════════════════════════════════════════
// Pool Reserve Snapshot
// ═══════════════════════════════════════════════

import type { VenueType } from './trade.types';

/** Raw reserve data decoded from a pool / bonding-curve account */
export interface PoolReserves {
  readonly baseReserve: bigint;   // Token reserve in smallest unit
  readonly quoteReserve: bigint;  // SOL reserve in lamports
  readonly lpSupply: bigint;      // Total LP token supply (0 when N/A, e.g. bonding curve)
  readonly poolOpenTime: number;  // Unix timestamp — when pool became active (0 when unknown)
}

// ═══════════════════════════════════════════════
// Liquidity Snapshot — Timestamped Pool State
// ═══════════════════════════════════════════════

/** Point-in-time snapshot of a pool / bonding curve's liquidity state */
export interface LiquiditySnapshot {
  readonly poolId: string;
  readonly tokenMint: string;
  readonly venue: VenueType;
  readonly reserves: PoolReserves;
  readonly fetchedAt: number; // Unix timestamp ms
  /**
   * Bonding-curve graduation flag (Pump.fun only).
   * true = curve complete → token migrated to PumpSwap, curve is dead.
   * undefined for non-pumpfun venues.
   */
  readonly complete?: boolean;
}

// ═══════════════════════════════════════════════
// Swap Simulation Output
// ═══════════════════════════════════════════════

/** Result of simulating a swap against pool reserves (pre-flight check) */
export interface SwapSimulationResult {
  readonly amountOut: bigint;           // Expected output amount
  readonly priceImpactPct: number;      // Price impact as percentage (0-100)
  readonly effectiveSlippageBps: number; // Actual slippage in basis points
  readonly minimumAmountOut: bigint;    // Minimum acceptable output after slippage
}

// ═══════════════════════════════════════════════
// Swap Execution Parameters
// ═══════════════════════════════════════════════

/** Compiled parameters ready for transaction assembly */
export interface SwapExecutionParams {
  readonly poolId: string;
  readonly tokenMint: string;
  readonly venue: VenueType;
  readonly amountIn: bigint;
  readonly minimumAmountOut: bigint;
  readonly slippageBps: number;
  readonly priorityFeeMicroLamports: number;
}
