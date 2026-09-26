import type { PoolReserves, SwapSimulationResult } from '../types/pool.types';
import { createLogger } from '../utils/logger';

const logger = createLogger('SlippageCalculator');

/**
 * Simulates a constant-product AMM swap and computes output amount with slippage.
 *
 * AMM Formula (Constant Product):
 *   dy = (y × dx) / (x + dx)
 *
 * Where:
 *   x  = input reserve (quoteReserve for BUY, baseReserve for SELL)
 *   y  = output reserve (baseReserve for BUY, quoteReserve for SELL)
 *   dx = input amount
 *   dy = output amount (before fees)
 *
 * Raydium charges a 0.25% swap fee (25 basis points) deducted from input.
 *
 * @param reserves     - Current pool reserve state
 * @param amountIn     - Input amount in lamports/smallest unit (bigint)
 * @param isBuy        - True for BUY (SOL → Token), false for SELL (Token → SOL)
 * @param maxSlippageBps - Maximum allowed slippage in basis points
 */
export function simulateSwap(
  reserves: PoolReserves,
  amountIn: bigint,
  isBuy: boolean,
  maxSlippageBps: number
): SwapSimulationResult {
  // Raydium swap fee: 0.25% = 25 BPS
  const SWAP_FEE_BPS = 25n;
  const BPS_DENOMINATOR = 10_000n;

  // Deduct swap fee from input
  const feeAmount = (amountIn * SWAP_FEE_BPS) / BPS_DENOMINATOR;
  const amountInAfterFee = amountIn - feeAmount;

  // Select reserves based on direction
  const inputReserve = isBuy ? reserves.quoteReserve : reserves.baseReserve;
  const outputReserve = isBuy ? reserves.baseReserve : reserves.quoteReserve;

  // Constant product formula: dy = (y × dx) / (x + dx)
  const numerator = outputReserve * amountInAfterFee;
  const denominator = inputReserve + amountInAfterFee;
  const amountOut = numerator / denominator;

  // Compute price impact: how much the trade moves the price
  // Price impact = 1 - (outputReserve - amountOut) / outputReserve × (inputReserve + amountInAfterFee) / inputReserve
  const priceImpactPct = computePriceImpact(
    inputReserve,
    outputReserve,
    amountInAfterFee,
    amountOut
  );

  // Compute effective slippage vs. ideal price (no-impact swap)
  const idealAmountOut = (outputReserve * amountInAfterFee) / inputReserve;
  const effectiveSlippageBps =
    idealAmountOut > 0n
      ? Number(((idealAmountOut - amountOut) * BPS_DENOMINATOR) / idealAmountOut)
      : 0;

  // Apply user's max slippage tolerance to compute minimum acceptable output
  const slippageMultiplier = BPS_DENOMINATOR - BigInt(maxSlippageBps);
  const minimumAmountOut = (amountOut * slippageMultiplier) / BPS_DENOMINATOR;

  logger.debug(
    {
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      priceImpactPct: priceImpactPct.toFixed(4),
      effectiveSlippageBps,
      minimumAmountOut: minimumAmountOut.toString(),
    },
    'Swap simulation completed'
  );

  return {
    amountOut,
    priceImpactPct,
    effectiveSlippageBps,
    minimumAmountOut,
  };
}

/**
 * Computes price impact as a percentage.
 * Uses the ratio of the effective price vs. the spot price.
 */
function computePriceImpact(
  inputReserve: bigint,
  outputReserve: bigint,
  amountIn: bigint,
  amountOut: bigint
): number {
  if (inputReserve === 0n || outputReserve === 0n) return 100;

  // Spot price: outputReserve / inputReserve
  // Effective price: amountOut / amountIn
  // Price impact = 1 - (effectivePrice / spotPrice)
  const spotPriceNumerator = outputReserve * amountIn;
  const effectivePriceNumerator = amountOut * inputReserve;

  if (spotPriceNumerator === 0n) return 100;

  const impactBps =
    ((spotPriceNumerator - effectivePriceNumerator) * 10_000n) /
    spotPriceNumerator;

  return Number(impactBps) / 100; // Convert BPS to percentage
}
