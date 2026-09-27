import { Connection, type Logs } from '@solana/web3.js';
import {
  RAYDIUM_V4_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMPSWAP_AMM_PROGRAM_ID,
  SOLANA_COMMITMENT,
} from '../config/constants';
import { loadEnvironment } from '../config/environment';
import { filterLogsByVenue } from './radar.filter';
import { enqueueTradePayload } from './radar.producer';
import type { VenueType } from '../types/trade.types';
import { createLogger } from '../utils/logger';

const logger = createLogger('RadarListener');

interface ActiveSubscription {
  readonly venue: VenueType;
  readonly subscriptionId: number;
}

let activeSubscriptions: ActiveSubscription[] = [];
let activeConnection: Connection | null = null;

/** Programs watched by the Radar, each mapped to its execution venue. */
const WATCHED_PROGRAMS: ReadonlyArray<{ venue: VenueType; programId: typeof RAYDIUM_V4_PROGRAM_ID }> = [
  { venue: 'raydium', programId: RAYDIUM_V4_PROGRAM_ID },
  { venue: 'pumpfun', programId: PUMP_PROGRAM_ID },
  { venue: 'pumpswap', programId: PUMPSWAP_AMM_PROGRAM_ID },
];

/**
 * Starts WebSocket subscriptions for all watched programs (Raydium V4,
 * Pump.fun bonding curve, PumpSwap AMM).
 * Listens for new pool activity and token swaps via Alchemy WSS.
 *
 * Flow: WebSocket → venue filter → FOMO gate → validate → enqueue to BullMQ
 */
export function startRadarListener(): void {
  const config = loadEnvironment();

  // Connection endpoint must be http(s); WSS goes in wsEndpoint option
  const wssConnection = new Connection(
    config.ALCHEMY_RPC_HTTP_URL,
    {
      commitment: SOLANA_COMMITMENT,
      wsEndpoint: config.ALCHEMY_RPC_WSS_URL,
    }
  );
  activeConnection = wssConnection;

  for (const { venue, programId } of WATCHED_PROGRAMS) {
    logger.info(
      { venue, programId: programId.toBase58() },
      'Initializing Radar — subscribing to program logs'
    );

    const subscriptionId = wssConnection.onLogs(
      programId,
      (logs: Logs) => {
        handleIncomingLogs(logs, venue);
      },
      SOLANA_COMMITMENT
    );

    activeSubscriptions.push({ venue, subscriptionId });

    logger.info(
      { venue, subscriptionId },
      'Radar listener active — scanning program logs'
    );
  }
}

/**
 * Processes incoming log entries from the WebSocket stream.
 * Delegates filtering to the venue-specific RadarFilter and enqueuing
 * to RadarProducer.
 */
function handleIncomingLogs(logs: Logs, venue: VenueType): void {
  // Skip failed transactions — no useful data
  if (logs.err) {
    logger.debug(
      { venue, signature: logs.signature },
      'Skipping failed transaction log'
    );
    return;
  }

  // Extract and validate trade-relevant data
  const filterResult = filterLogsByVenue(logs, venue);

  if (!filterResult) {
    return; // Not a target event — discard silently
  }

  logger.info(
    {
      venue,
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
 * Stops all WebSocket subscriptions and cleans up.
 */
export async function stopRadarListener(): Promise<void> {
  if (activeConnection !== null) {
    for (const { venue, subscriptionId } of activeSubscriptions) {
      try {
        await activeConnection.removeOnLogsListener(subscriptionId);
      } catch {
        // Subscription may already be closed during shutdown — ignore
      }
      logger.info({ venue, subscriptionId }, 'Radar subscription stopped');
    }
  }
  activeSubscriptions = [];
  activeConnection = null;
  logger.info('Radar listener stopped');
}
