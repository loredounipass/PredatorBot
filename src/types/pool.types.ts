// ═══════════════════════════════════════════════
// Pool Reserve Snapshot
// ═══════════════════════════════════════════════

/** Raw reserve data decoded from Raydium AMM pool account */
export interface PoolReserves {
  readonly baseReserve: bigint;   // Token reserve in smallest unit
  readonly quoteReserve: bigint;  // SOL reserve in lamports
  readonly lpSupply: bigint;      // Total LP token supply
  readonly poolOpenTime: number;  // Unix timestamp — when pool became active
}

// ═══════════════════════════════════════════════
// Liquidity Snapshot — Timestamped Pool State
// ═══════════════════════════════════════════════

/** Point-in-time snapshot of a Raydium pool's liquidity state */
export interface LiquiditySnapshot {
  readonly poolId: string;
  readonly tokenMint: string;
  readonly reserves: PoolReserves;
  readonly fetchedAt: number; // Unix timestamp ms
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
  readonly amountIn: bigint;
  readonly minimumAmountOut: bigint;
  readonly slippageBps: number;
  readonly priorityFeeMicroLamports: number;
}
