import { getExecutionQueue } from '../queue/queue.manager';
import { validateTradePayload } from '../queue/queue.schemas';
import { SWAP_JOB_NAME } from '../config/constants';
import { loadEnvironment } from '../config/environment';
import type { RadarSignal } from './radar.filter';
import type { TradePayload } from '../types/trade.types';
import { createLogger } from '../utils/logger';

const logger = createLogger('RadarProducer');

/**
 * Validates and enqueues a trade payload into the BullMQ execution queue.
 * Acts as the bridge between the Radar subsystem and the Worker subsystem.
 *
 * @param signal - Validated radar signal from the filter layer
 */
export async function enqueueTradePayload(signal: RadarSignal): Promise<void> {
  const config = loadEnvironment();

  // Assemble full payload from signal + config
  const payload: TradePayload = {
    tokenMint: signal.tokenMint,
    poolId: signal.poolId,
    amountSol: config.TRADE_AMOUNT_SOL,
    direction: signal.direction,
    detectedAt: signal.detectedAt,
  };

  // Runtime validation before enqueuing
  const validation = validateTradePayload(payload);

  if (!validation.success) {
    const errors = validation.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ');

    logger.warn(
      { errors },
      'Trade payload failed validation — discarding'
    );
    return;
  }

  // Enqueue with retry configuration from env
  const queue = getExecutionQueue();

  await queue.add(SWAP_JOB_NAME, payload, {
    attempts: config.JOB_MAX_RETRY_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: config.JOB_RETRY_BACKOFF_MS,
    },
  });

  logger.info(
    {
      tokenMint: payload.tokenMint,
      poolId: payload.poolId,
      direction: payload.direction,
      amountSol: payload.amountSol,
    },
    'Trade payload enqueued to execution queue'
  );
}
