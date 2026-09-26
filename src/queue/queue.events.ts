import type { Queue } from 'bullmq';
import { createLogger } from '../utils/logger';
import type { TradePayload } from '../types/trade.types';

const logger = createLogger('QueueEvents');

/**
 * Attaches lifecycle event handlers to the execution queue.
 * Provides observability into queue health without coupling to worker logic.
 *
 * @param queue - The BullMQ Queue instance to monitor
 */
export function attachQueueEventHandlers(
  queue: Queue<TradePayload>
): void {
  queue.on('error', (error) => {
    logger.error(
      { error: error.message },
      'Queue encountered an error'
    );
  });

  // Note: BullMQ Queue emits limited events.
  // For full lifecycle tracking (stalled, drained, progress),
  // use QueueEvents listener from BullMQ if needed.
  logger.info(
    { queueName: queue.name },
    'Queue event handlers attached'
  );
}

/**
 * Logs a summary of the queue's current state.
 * Useful for health checks and diagnostics.
 */
export async function logQueueHealthSnapshot(
  queue: Queue<TradePayload>
): Promise<void> {
  const jobCounts = await queue.getJobCounts(
    'waiting', 'active', 'completed', 'failed', 'delayed'
  );

  logger.info(
    {
      queueName: queue.name,
      waiting: jobCounts.waiting,
      active: jobCounts.active,
      completed: jobCounts.completed,
      failed: jobCounts.failed,
      delayed: jobCounts.delayed,
    },
    'Queue health snapshot'
  );
}
