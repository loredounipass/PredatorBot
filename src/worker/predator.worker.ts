import { Worker, Job } from 'bullmq';
import { Connection } from '@solana/web3.js';
import { createRedisConnection } from '../config/redis.config';
import { loadEnvironment } from '../config/environment';
import {
  PREDATOR_QUEUE_NAME,
  SOLANA_COMMITMENT,
  BUY_MAX_FEE_RESERVE_LAMPORTS,
} from '../config/constants';
import type { TradePayload, VenueType } from '../types/trade.types';
import type { LiquiditySnapshot, SwapExecutionParams } from '../types/pool.types';
import { getFomoMintAllowlist } from '../config/environment';
import { PredatorError, PredatorErrorCode } from '../types/system.types';
import { loadWalletKeypair } from '../wallet/wallet.loader';
import { fetchPoolSnapshot } from './pool.engine';
import {
  buildRaydiumV4SwapInstructions,
  getRaydiumPoolKeys,
  getTokenBalanceRaw,
  resolveSellAmountRaw,
} from './swap.instructions';
import { simulateSwap } from './slippage.calculator';
import { buildSwapTransaction } from './transaction.builder';
import { signAndDispatchTransaction } from './transaction.signer';
import {
  insertPendingTrade,
  markTradeCompleted,
  markTradeFailed,
} from '../database/trade.repository';
import { solToLamports, lamportsToSol } from '../utils/sol.helpers';
import { parsePublicKey } from '../utils/sol.helpers';
import { createLogger } from '../utils/logger';

const logger = createLogger('PredatorWorker');

let workerInstance: Worker<TradePayload> | null = null;

/**
 * Spawns the BullMQ Worker that consumes swap jobs from the execution queue.
 * Each job flows through the full execution pipeline:
 *   1. Pre-flight MongoDB write (PENDING_ON_CHAIN)
 *   2. Pool reserve fetch
 *   3. Slippage simulation
 *   4. Transaction assembly + signing
 *   5. RPC dispatch + confirmation
 *   6. MongoDB status update (COMPLETED | FAILED)
 */
export function spawnPredatorWorker(): Worker<TradePayload> {
  if (workerInstance) return workerInstance;

  const config = loadEnvironment();
  const redisConnection = createRedisConnection();

  workerInstance = new Worker<TradePayload>(
    PREDATOR_QUEUE_NAME,
    async (job: Job<TradePayload>) => {
      await processSwapJob(job);
    },
    {
      connection: redisConnection,
      concurrency: config.WORKER_CONCURRENCY,
      limiter: {
        max: config.RATE_LIMIT_MAX_RPS,
        duration: 1000,
      },
    }
  );

  // Lifecycle event handlers
  workerInstance.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Swap job completed successfully');
  });

  workerInstance.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, error: error.message },
      'Swap job pipeline failed'
    );
  });

  workerInstance.on('error', (error) => {
    logger.error({ error: error.message }, 'Worker encountered an error');
  });

  logger.info(
    {
      concurrency: config.WORKER_CONCURRENCY,
      rateLimitRPS: config.RATE_LIMIT_MAX_RPS,
    },
    'PredatorWorker spawned and listening for jobs'
  );

  return workerInstance;
}

/**
 * Core job processor — orchestrates the full swap execution pipeline.
 */
async function processSwapJob(job: Job<TradePayload>): Promise<void> {
  const { tokenMint, poolId, amountSol, direction, orderType, limitPrice } = job.data;
  // Default keeps jobs enqueued before the multi-venue upgrade working.
  const venue: VenueType = job.data.venue ?? 'raydium';
  const jobId = job.id ?? 'unknown';

  logger.info(
    { jobId, tokenMint, direction, amountSol, venue, orderType, limitPrice },
    'Processing swap job'
  );

  const config = loadEnvironment();
  const connection = new Connection(config.ALCHEMY_RPC_HTTP_URL, SOLANA_COMMITMENT);
  const walletKeypair = loadWalletKeypair();

  // Step 1: Pre-flight MongoDB record
  const dbResult = await insertPendingTrade(
    jobId, tokenMint, poolId, amountSol, direction, venue
  );
  const documentId = dbResult.insertedId;

  try {
    // Real on-chain execution is implemented for the Raydium V4 venue.
    // Other venues fail fast here — never send a transaction without
    // venue-specific swap instructions.
    assertVenueSupported(venue);

    // Step 2: Pool keys (cached) + reserves (venue-aware decoding).
    // Raydium snapshots come oriented: base = token side, quote = SOL side.
    const poolKeys = await getRaydiumPoolKeys(poolId);
    const tokenMintPubkey = parsePublicKey(tokenMint, 'tokenMint');
    const poolSnapshot = await fetchPoolSnapshot(connection, poolId, tokenMint, venue);
    const reserves = poolSnapshot.reserves;

    // Step 2b: Graduation / verification gates (FOMO criteria)
    enforceGraduationGate(poolSnapshot, tokenMint, venue);
    enforceVerifiedGate(tokenMint, venue);

    // Step 2c: Limit order price gate - usa Dexscreener para coincidir con la UI
    if ((orderType ?? 'MARKET') === 'LIMIT' && typeof limitPrice === 'number' && !isNaN(limitPrice)) {
      try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${poolId}`);
        const data = await r.json() as any;
        const pair = data?.pairs?.[0];
        const priceNative = pair?.priceNative ? Number(pair.priceNative) : null;
        if (priceNative === null || isNaN(priceNative)) {
          throw new PredatorError(
            PredatorErrorCode.POOL_NOT_FOUND,
            `No se pudo obtener precio en tiempo real de Dexscreener para ${poolId}`,
            { poolId, tokenMint }
          );
        }
        const currentPrice = priceNative;
        const priceOk = direction === 'BUY' ? currentPrice <= limitPrice : currentPrice >= limitPrice;
        if (!priceOk) {
          throw new PredatorError(
            PredatorErrorCode.PRICE_LIMIT_NOT_MET,
            `Precio límite no alcanzado: precio actual ${currentPrice.toFixed(9)} SOL/token, límite ${limitPrice} para ${direction}`,
            { tokenMint, currentPrice, limitPrice, direction }
          );
        }
        logger.info({ jobId, currentPrice, limitPrice, direction }, 'Limit order price check passed');
      } catch (err) {
        if (err instanceof PredatorError) throw err;
        throw new PredatorError(
          PredatorErrorCode.POOL_NOT_FOUND,
          `Error al validar precio límite: ${err instanceof Error ? err.message : 'unknown'}`,
          { poolId, tokenMint }
        );
      }
    }

    // Step 3: Resolve input amount + simulate swap for slippage.
    // Local math only (no RPC simulation round-trip) — HFT path.
    // Balance is the only RPC read here; the decision table lives in
    // resolveJobAmountInRaw (unit-tested without network).
    const isBuy = direction === 'BUY';
    const sellAll = job.data.sellAll === true;
    const buyMax = job.data.buyMax === true;
    let amountInRaw: bigint;
    let solBalanceRaw: bigint;

    if (isBuy) {
      solBalanceRaw = buyMax
        ? BigInt(await connection.getBalance(walletKeypair.publicKey))
        : BigInt(await connection.getBalance(walletKeypair.publicKey));
      amountInRaw = resolveJobAmountInRaw({ direction, sellAll, buyMax, amountSol, solBalanceRaw });
      if (buyMax) {
        logger.info(
          { jobId, solBalanceRaw: solBalanceRaw.toString(), amountInRaw: amountInRaw.toString() },
          'BUY-MAX mode — spending entire SOL balance minus fee reserve'
        );
      }
      // Pre-flight SOL check
      const requiredSol = amountInRaw + BigInt(BUY_MAX_FEE_RESERVE_LAMPORTS);
      if (solBalanceRaw < requiredSol) {
        throw new PredatorError(
          PredatorErrorCode.INSUFFICIENT_BALANCE,
          `Insufficient SOL for BUY: need ${lamportsToSol(requiredSol)} SOL (amount ${lamportsToSol(amountInRaw)} + fee reserve), have ${lamportsToSol(solBalanceRaw)} SOL`,
          { tokenMint, amountSol, requiredSol: requiredSol.toString(), solBalance: solBalanceRaw.toString() }
        );
      }
    } else {
      const { balanceRaw } = await getTokenBalanceRaw(connection, walletKeypair.publicKey, tokenMintPubkey);
      amountInRaw = resolveJobAmountInRaw({
        direction,
        sellAll,
        amountSol,
        balanceRaw,
        baseReserve: reserves.baseReserve,
        quoteReserve: reserves.quoteReserve,
      });
      if (sellAll) {
        logger.info(
          { jobId, balanceRaw: balanceRaw.toString() },
          'SELL-ALL mode — selling entire ATA balance'
        );
      }
      // Pre-flight SOL for fees on SELL
      solBalanceRaw = BigInt(await connection.getBalance(walletKeypair.publicKey));
      if (solBalanceRaw < BigInt(BUY_MAX_FEE_RESERVE_LAMPORTS)) {
        throw new PredatorError(
          PredatorErrorCode.INSUFFICIENT_BALANCE,
          `Insufficient SOL for transaction fees on SELL: need ${lamportsToSol(BigInt(BUY_MAX_FEE_RESERVE_LAMPORTS))} SOL reserve, have ${lamportsToSol(solBalanceRaw)} SOL`,
          { tokenMint, solBalance: solBalanceRaw.toString() }
        );
      }
    }

    const simulation = simulateSwap(
      reserves,
      amountInRaw,
      isBuy,
      config.MAX_SLIPPAGE_BPS
    );

    logger.info(
      {
        amountIn: amountInRaw.toString(),
        amountOut: simulation.amountOut.toString(),
        priceImpact: simulation.priceImpactPct.toFixed(4) + '%',
        slippageBps: simulation.effectiveSlippageBps,
      },
      'Swap simulation completed'
    );

    // Step 4: Build REAL V4 swap instructions (wrap + swap [+ unwrap])
    const swapParams: SwapExecutionParams = {
      poolId,
      tokenMint,
      venue,
      amountIn: amountInRaw,
      minimumAmountOut: simulation.minimumAmountOut,
      slippageBps: config.MAX_SLIPPAGE_BPS,
      priorityFeeMicroLamports: config.PRIORITY_FEE_MICROLAMPORTS,
    };

    const swapInstructions = await buildRaydiumV4SwapInstructions({
      connection,
      wallet: walletKeypair.publicKey,
      poolKeys,
      tokenMint: tokenMintPubkey,
      direction,
      amountInRaw,
      minimumAmountOutRaw: simulation.minimumAmountOut,
    });

    // Step 5: Assemble versioned tx (compute budget + instructions)

    const versionedTx = await buildSwapTransaction(
      connection,
      walletKeypair.publicKey,
      swapInstructions,
      swapParams,
      null // ATA creation is included in swapInstructions
    );

    // Step 6: Sign and dispatch (skipPreflight — no RPC simulation round-trip)
    const dispatchResult = await signAndDispatchTransaction(
      connection,
      versionedTx,
      walletKeypair
    );

    // Step 7: Mark trade as completed
    const executionPrice = lamportsToSol(simulation.amountOut);

    await markTradeCompleted(
      documentId,
      dispatchResult.txSignature,
      executionPrice,
      simulation.effectiveSlippageBps,
      config.PRIORITY_FEE_MICROLAMPORTS
    );

    logger.info(
      { jobId, txSignature: dispatchResult.txSignature },
      'Swap executed and persisted successfully'
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    await markTradeFailed(documentId, message);

    logger.error({ jobId, error: message }, 'Swap execution failed');

    // Re-throw to trigger BullMQ retry logic
    throw error;
  }
}

/**
 * Venue gate (pure): only Raydium V4 has live swap instructions.
 * Exported for unit tests — processSwapJob calls it before any RPC.
 */
export function assertVenueSupported(venue: VenueType): void {
  if (venue !== 'raydium') {
    throw new PredatorError(
      PredatorErrorCode.VENUE_UNSUPPORTED,
      `Live execution for venue "${venue}" is not wired yet — swap instructions missing`,
      { venue }
    );
  }
}

/**
 * Pure amount resolution for a job (no RPC).
 * Exported for unit tests — processSwapJob fetches balanceRaw first,
 * then delegates here so the decision table is tested without network.
 */
export function resolveJobAmountInRaw(input: {
  direction: 'BUY' | 'SELL';
  sellAll: boolean;
  buyMax?: boolean;
  amountSol: number;
  balanceRaw?: bigint;
  solBalanceRaw?: bigint;
  baseReserve?: bigint;
  quoteReserve?: bigint;
}): bigint {
  const { direction, sellAll, amountSol } = input;
  const buyMax = input.buyMax === true;
  if (direction === 'BUY') {
    if (sellAll) {
      throw new PredatorError(
        PredatorErrorCode.INVALID_INPUT,
        'sellAll (MAX) only applies to SELL — use a SOL amount for BUY',
        {}
      );
    }
    if (buyMax) {
      const solBalance = input.solBalanceRaw;
      if (solBalance === undefined) {
        throw new PredatorError(
          PredatorErrorCode.INVALID_INPUT,
          'BUY MAX requires the wallet SOL balance',
          {}
        );
      }
      if (solBalance <= BigInt(BUY_MAX_FEE_RESERVE_LAMPORTS)) {
        throw new PredatorError(
          PredatorErrorCode.INSUFFICIENT_BALANCE,
          'Nothing to buy — SOL balance does not cover the fee reserve (MAX requested)',
          { solBalance: solBalance.toString() }
        );
      }
      return solBalance - BigInt(BUY_MAX_FEE_RESERVE_LAMPORTS);
    }
    return solToLamports(amountSol);
  }
  if (buyMax) {
    throw new PredatorError(
      PredatorErrorCode.INVALID_INPUT,
      'buyMax (MAX) only applies to BUY — use sellAll for SELL',
      {}
    );
  }
  const balanceRaw = input.balanceRaw ?? 0n;
  if (sellAll) {
    if (balanceRaw <= 0n) {
      throw new PredatorError(
        PredatorErrorCode.INSUFFICIENT_BALANCE,
        'Nothing to sell — token balance is zero (MAX requested)',
        {}
      );
    }
    return balanceRaw;
  }
  return resolveSellAmountRaw(
    balanceRaw,
    solToLamports(amountSol),
    input.baseReserve ?? 0n,
    input.quoteReserve ?? 0n
  );
}

/**
 * Graduation gate: with FOMO_TRADE_GRADUATED_ONLY=true, bonding-curve
 * (pumpfun) jobs whose curve is NOT complete are rejected — only
 * graduated tokens (PumpSwap) are traded.
 */
export function enforceGraduationGate(
  snapshot: LiquiditySnapshot,
  tokenMint: string,
  venue: VenueType,
  opts?: { graduatedOnly?: boolean }
): void {
  const graduatedOnly = opts?.graduatedOnly ?? loadEnvironment().FOMO_TRADE_GRADUATED_ONLY;
  if (!graduatedOnly) return;
  if (venue !== 'pumpfun') return;

  if (snapshot.complete !== true) {
    throw new PredatorError(
      PredatorErrorCode.NOT_GRADUATED,
      `Token ${tokenMint} has not graduated yet (bonding curve incomplete) — skipping per FOMO_TRADE_GRADUATED_ONLY`,
      { tokenMint, venue, poolId: snapshot.poolId }
    );
  }
}

/**
 * Verification gate: with FOMO_ONLY_VERIFIED=true, only mints in
 * FOMO_MINT_ALLOWLIST are traded. There is no on-chain "verified"
 * flag — the allowlist is the operator-curated verified set.
 */
export function enforceVerifiedGate(
  tokenMint: string,
  venue: VenueType,
  opts?: { onlyVerified?: boolean; allowlist?: string[] }
): void {
  const onlyVerified = opts?.onlyVerified ?? loadEnvironment().FOMO_ONLY_VERIFIED;
  if (!onlyVerified) return;

  const allowlist = opts?.allowlist ?? getFomoMintAllowlist();
  if (!allowlist.includes(tokenMint)) {
    throw new PredatorError(
      PredatorErrorCode.NOT_VERIFIED,
      `Token ${tokenMint} is not in FOMO_MINT_ALLOWLIST — skipping per FOMO_ONLY_VERIFIED`,
      { tokenMint, venue }
    );
  }
}

/**
 * Gracefully shuts down the PredatorWorker.
 * Waits for active jobs to complete before closing.
 */
export async function closePredatorWorker(): Promise<void> {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
    logger.info('PredatorWorker shut down gracefully');
  }
}
