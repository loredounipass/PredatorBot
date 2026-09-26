import { Queue } from 'bullmq';
import { createRedisConnection } from '../config/redis.config';
import { loadEnvironment } from '../config/environment';
import { PREDATOR_QUEUE_NAME } from '../config/constants';
import { createLogger } from '../utils/logger';
import type { TradePayload } from '../types/trade.types';

const logger = createLogger('QueueManager');

let executionQueue: Queue<TradePayload> | null = null;

/**
 * Initializes the BullMQ execution queue with rate-limiting configuration.
 * Uses the PREDATOR_QUEUE_NAME constant as the queue identifier.
 */
export function initExecutionQueue(): Queue<TradePayload> {
  if (executionQueue) return executionQueue;

  const config = loadEnvironment();
  const redisConnection = createRedisConnection();

  executionQueue = new Queue<TradePayload>(PREDATOR_QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: config.JOB_MAX_RETRY_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: config.JOB_RETRY_BACKOFF_MS,
      },
      removeOnComplete: {
        count: 1000, // Keep last 1000 completed jobs for audit
      },
      removeOnFail: {
        count: 500,  // Keep last 500 failed jobs for debugging
      },
    },
  });

  logger.info(
    {
      queueName: PREDATOR_QUEUE_NAME,
      maxRetries: config.JOB_MAX_RETRY_ATTEMPTS,
      backoffMs: config.JOB_RETRY_BACKOFF_MS,
    },
    'Execution queue initialized'
  );

  return executionQueue;
}

/**
 * Returns the cached execution queue instance.
 * Throws if called before initExecutionQueue().
 */
export function getExecutionQueue(): Queue<TradePayload> {
  if (!executionQueue) {
    throw new Error('Execution queue not initialized — call initExecutionQueue() first');
  }
  return executionQueue;
}

/**
 * Gracefully closes the execution queue.
 */
export async function closeExecutionQueue(): Promise<void> {
  if (executionQueue) {
    await executionQueue.close();
    executionQueue = null;
    logger.info('Execution queue closed gracefully');
  }
}
