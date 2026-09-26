import IORedis from 'ioredis';
import { loadEnvironment } from './environment';
import { createLogger } from '../utils/logger';

const logger = createLogger('RedisConfig');

let redisInstance: IORedis | null = null;

/**
 * Creates or returns the singleton Redis connection.
 * BullMQ requires `maxRetriesPerRequest: null` to function correctly.
 */
export function createRedisConnection(): IORedis {
  if (redisInstance) return redisInstance;

  const config = loadEnvironment();

  redisInstance = new IORedis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: true,
    family: 4,
    retryStrategy(retryAttempt: number): number | null {
      if (retryAttempt > 10) {
        logger.fatal({ retryAttempt }, 'Redis connection exhausted all retries');
        return null; // Stop retrying
      }
      // Exponential backoff: 200ms, 400ms, 800ms... capped at 5s
      return Math.min(retryAttempt * 200, 5000);
    },
  });

  redisInstance.on('connect', () => {
    logger.info('Redis connection established');
  });

  redisInstance.on('error', (error) => {
    logger.error({ error: error.message }, 'Redis connection error');
  });

  redisInstance.on('close', () => {
    logger.warn('Redis connection closed');
  });

  return redisInstance;
}

/**
 * Gracefully disconnects the Redis singleton.
 */
export async function disconnectRedis(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
    logger.info('Redis disconnected gracefully');
  }
}
