import type { Logs } from '@solana/web3.js';
import { WSOL_MINT, TARGET_TOKEN_MINT } from '../config/constants';
import { isValidPublicKey } from '../utils/sol.helpers';
import { createLogger } from '../utils/logger';

const logger = createLogger('RadarFilter');

/** Extracted trade signal from Raydium logs */
export interface RadarSignal {
  readonly tokenMint: string;
  readonly poolId: string;
  readonly direction: 'BUY' | 'SELL';
  readonly detectedAt: number;
}

// Known log signatures for Raydium AMM V4 operations
const RAYDIUM_INIT_LOG_PREFIX = 'ray_log:';
const POOL_INIT_KEYWORDS = ['initialize', 'Initialize2'];
const SWAP_KEYWORDS = ['swap', 'Swap'];

/**
 * Filters raw Raydium program logs to identify actionable trade signals.
 *
 * L1 Filter: Checks for swap or pool initialization events
 * L2 Filter: Extracts token mint and pool ID from account keys
 * L3 Filter: Validates extracted addresses and matches against target
 *
 * @param logs - Raw log data from WebSocket subscription
 * @returns RadarSignal if a valid target event is detected, null otherwise
 */
export function filterRaydiumLogs(logs: Logs): RadarSignal | null {
  const logMessages = logs.logs;

  if (!logMessages || logMessages.length === 0) return null;

  // L1: Detect event type from log messages
  const isSwapEvent = logMessages.some((msg) =>
    SWAP_KEYWORDS.some((keyword) => msg.includes(keyword))
  );

  const isPoolInitEvent = logMessages.some((msg) =>
    POOL_INIT_KEYWORDS.some((keyword) => msg.includes(keyword))
  );

  if (!isSwapEvent && !isPoolInitEvent) return null;

  // L2: Extract pool ID and token mints from log data
  const extractedData = extractPoolAndMintFromLogs(logMessages);

  if (!extractedData) {
    logger.debug('Could not extract pool/mint data from logs');
    return null;
  }

  // L3: Validate target match
  const targetMintBase58 = TARGET_TOKEN_MINT.toBase58();

  if (extractedData.tokenMint !== targetMintBase58) {
    return null; // Not our target — silent discard
  }

  return {
    tokenMint: extractedData.tokenMint,
    poolId: extractedData.poolId,
    direction: 'BUY', // Default to BUY for initial detection
    detectedAt: Date.now(),
  };
}

/**
 * Parses Raydium log entries to extract pool ID and non-WSOL token mint.
 * Searches for base58-encoded public keys in ray_log entries.
 */
function extractPoolAndMintFromLogs(
  logMessages: string[]
): { poolId: string; tokenMint: string } | null {
  const wsolMintBase58 = WSOL_MINT.toBase58();
  let poolId: string | null = null;
  let tokenMint: string | null = null;

  for (const message of logMessages) {
    // Look for ray_log entries that contain encoded data
    if (!message.includes(RAYDIUM_INIT_LOG_PREFIX)) continue;

    // Extract potential public keys from log messages
    // Raydium logs encode pool and mint addresses in instruction data
    const words = message.split(/\s+/);

    for (const word of words) {
      // Base58 Solana addresses are 32-44 characters
      if (word.length >= 32 && word.length <= 44 && isValidPublicKey(word)) {
        if (word === wsolMintBase58) continue; // Skip WSOL

        // Heuristic: first valid key is poolId, second is tokenMint
        if (!poolId) {
          poolId = word;
        } else if (!tokenMint) {
          tokenMint = word;
        }
      }
    }
  }

  if (!poolId || !tokenMint) return null;

  return { poolId, tokenMint };
}
