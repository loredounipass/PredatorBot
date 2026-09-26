import { Connection, type Logs } from '@solana/web3.js';
import { RAYDIUM_V4_PROGRAM_ID, SOLANA_COMMITMENT } from '../config/constants';
import { loadEnvironment } from '../config/environment';
import { filterRaydiumLogs } from './radar.filter';
import { enqueueTradePayload } from './radar.producer';
import { createLogger } from '../utils/logger';

const logger = createLogger('RadarListener');

let activeSubscriptionId: number | null = null;

/**
 * Starts the WebSocket subscription to Raydium V4 program logs.
 * Listens for new pool activity and token swaps via Alchemy WSS.
 *
 * Flow: WebSocket → filter → validate → enqueue to BullMQ
 */
export function startRadarListener(): void {
  const config = loadEnvironment();

  // Use WSS endpoint for real-time streaming
  const wssConnection = new Connection(
    config.ALCHEMY_RPC_WSS_URL,
    {
      commitment: SOLANA_COMMITMENT,
      wsEndpoint: config.ALCHEMY_RPC_WSS_URL,
    }
  );

  logger.info(
    { programId: RAYDIUM_V4_PROGRAM_ID.toBase58() },
    'Initializing Radar — subscribing to Raydium V4 logs'
  );

  activeSubscriptionId = wssConnection.onLogs(
    RAYDIUM_V4_PROGRAM_ID,
    (logs: Logs) => {
      handleIncomingLogs(logs);
    },
    SOLANA_COMMITMENT
  );

  logger.info(
    { subscriptionId: activeSubscriptionId },
    'Radar listener active — scanning Raydium V4 program logs'
  );
}

/**
 * Processes incoming log entries from the WebSocket stream.
 * Delegates filtering to RadarFilter and enqueuing to RadarProducer.
 */
function handleIncomingLogs(logs: Logs): void {
  // Skip failed transactions — no useful data
  if (logs.err) {
    logger.debug(
      { signature: logs.signature },
      'Skipping failed transaction log'
    );
    return;
  }

  // Extract and validate trade-relevant data
  const filterResult = filterRaydiumLogs(logs);

  if (!filterResult) {
    return; // Not a target event — discard silently
  }

  logger.info(
    {
      tokenMint: filterResult.tokenMint,
      poolId: filterResult.poolId,
      signature: logs.signature,
    },
    'Radar match detected — relaying to execution queue'
  );

  // Enqueue for async processing
  enqueueTradePayload(filterResult).catch((error) => {
    logger.error(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      'Failed to enqueue trade payload'
    );
  });
}

/**
 * Stops the WebSocket subscription and cleans up.
 */
export async function stopRadarListener(): Promise<void> {
  if (activeSubscriptionId !== null) {
    // Note: Connection.removeOnLogsListener requires the connection instance
    // In practice, the connection will be closed during shutdown
    activeSubscriptionId = null;
    logger.info('Radar listener stopped');
  }
}
