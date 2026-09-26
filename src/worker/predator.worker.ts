import { Worker, Job } from 'bullmq';
import { Connection } from '@solana/web3.js';
import { createRedisConnection } from '../config/redis.config';
import { loadEnvironment } from '../config/environment';
import {
  PREDATOR_QUEUE_NAME,
  SOLANA_COMMITMENT,
} from '../config/constants';
import type { TradePayload } from '../types/trade.types';
import type { SwapExecutionParams } from '../types/pool.types';
import { loadWalletKeypair } from '../wallet/wallet.loader';
import { getOrCreateATAInstruction } from '../wallet/ata.manager';
import { fetchPoolSnapshot } from './pool.engine';
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
  const { tokenMint, poolId, amountSol, direction } = job.data;
  const jobId = job.id ?? 'unknown';

  logger.info(
    { jobId, tokenMint, direction, amountSol },
    'Processing swap job'
  );

  const config = loadEnvironment();
  const connection = new Connection(config.ALCHEMY_RPC_HTTP_URL, SOLANA_COMMITMENT);
  const walletKeypair = loadWalletKeypair();

  // Step 1: Pre-flight MongoDB record
  const dbResult = await insertPendingTrade(
    jobId, tokenMint, poolId, amountSol, direction
  );
  const documentId = dbResult.insertedId;

  try {
    // Step 2: Fetch pool reserves
    const poolSnapshot = await fetchPoolSnapshot(connection, poolId, tokenMint);

    // Step 3: Simulate swap for slippage calculation
    const amountInLamports = solToLamports(amountSol);
    const isBuy = direction === 'BUY';

    const simulation = simulateSwap(
      poolSnapshot.reserves,
      amountInLamports,
      isBuy,
      config.MAX_SLIPPAGE_BPS
    );

    logger.info(
      {
        amountOut: simulation.amountOut.toString(),
        priceImpact: simulation.priceImpactPct.toFixed(4) + '%',
        slippageBps: simulation.effectiveSlippageBps,
      },
      'Swap simulation completed'
    );

    // Step 4: Ensure ATA exists for the target token
    const tokenMintPubkey = parsePublicKey(tokenMint, 'tokenMint');
    const { instruction: ataInstruction } = await getOrCreateATAInstruction(
      connection,
      walletKeypair.publicKey,
      tokenMintPubkey
    );

    // Step 5: Build transaction
    const swapParams: SwapExecutionParams = {
      poolId,
      tokenMint,
      amountIn: amountInLamports,
      minimumAmountOut: simulation.minimumAmountOut,
      slippageBps: config.MAX_SLIPPAGE_BPS,
      priorityFeeMicroLamports: config.PRIORITY_FEE_MICROLAMPORTS,
    };

    // TODO: Replace placeholder with actual Raydium swap instructions
    // const raydiumSwapIx = await buildRaydiumSwapInstruction(connection, swapParams);
    const swapInstructions: import('@solana/web3.js').TransactionInstruction[] = [];

    const versionedTx = await buildSwapTransaction(
      connection,
      walletKeypair.publicKey,
      swapInstructions,
      swapParams,
      ataInstruction
    );

    // Step 6: Sign and dispatch
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
