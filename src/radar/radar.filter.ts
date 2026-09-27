import type { Logs } from '@solana/web3.js';
import { WSOL_MINT, TARGET_TOKEN_MINT } from '../config/constants';
import {
  loadEnvironment,
  getFomoMintAllowlist,
  getFomoCreatorAllowlist,
} from '../config/environment';
import type { VenueType } from '../types/trade.types';
import { isValidPublicKey } from '../utils/sol.helpers';
import { createLogger } from '../utils/logger';

const logger = createLogger('RadarFilter');

/** Extracted trade signal from DEX program logs */
export interface RadarSignal {
  readonly tokenMint: string;
  readonly poolId: string;
  readonly venue: VenueType;
  readonly direction: 'BUY' | 'SELL';
  readonly detectedAt: number;
  /** Token creator wallet, when extractable from log data (pump programs). */
  readonly creator?: string;
}

// Known log signatures for Raydium AMM V4 operations
const RAYDIUM_INIT_LOG_PREFIX = 'ray_log:';
const POOL_INIT_KEYWORDS = ['initialize', 'Initialize2'];
const SWAP_KEYWORDS = ['swap', 'Swap'];

// Pump.fun / PumpSwap log markers (Anchor program logs)
const PUMP_CREATE_KEYWORDS = ['Create', 'create', 'initialize'];
const PUMP_TRADE_KEYWORDS = ['Buy', 'Sell', 'buy', 'sell', 'swap', 'Swap'];

/**
 * Checks a mint (and optional creator) against the FOMO family criteria.
 *
 * A mint matches when ALL non-empty criteria match:
 *   1. Suffix    — mint ends with FOMO_MINT_SUFFIX (pump family)
 *   2. Allowlist — mint is in FOMO_MINT_ALLOWLIST (verified set)
 *   3. Creator   — creator is in FOMO_CREATOR_ALLOWLIST
 *
 * Empty criterion = no restriction. Unknown creator passes the creator
 * check (it is only enforced when the creator is known AND allowlisted).
 */
export function matchesFomoFamily(tokenMint: string, creator?: string): boolean {
  const config = loadEnvironment();

  if (
    config.FOMO_MINT_SUFFIX.length > 0 &&
    !tokenMint.endsWith(config.FOMO_MINT_SUFFIX)
  ) {
    return false;
  }

  const mintAllowlist = getFomoMintAllowlist();
  if (mintAllowlist.length > 0 && !mintAllowlist.includes(tokenMint)) {
    return false;
  }

  const creatorAllowlist = getFomoCreatorAllowlist();
  if (
    creator !== undefined &&
    creatorAllowlist.length > 0 &&
    !creatorAllowlist.includes(creator)
  ) {
    return false;
  }

  return true;
}

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
    venue: 'raydium',
    direction: 'BUY', // Default to BUY for initial detection
    detectedAt: Date.now(),
  };
}

/**
 * Filters Pump.fun bonding-curve / PumpSwap program logs for FOMO family
 * trade signals.
 *
 * L1: Detect create/trade events from Anchor log markers
 * L2: Extract mint + pool/bonding-curve account from account keys
 * L3: Apply the FOMO family criteria (suffix / allowlist / creator)
 *
 * @param logs  - Raw log data from WebSocket subscription
 * @param venue - 'pumpfun' (bonding curve) or 'pumpswap' (graduated pools)
 * @returns RadarSignal if a FOMO family event is detected, null otherwise
 */
export function filterPumpLogs(logs: Logs, venue: 'pumpfun' | 'pumpswap'): RadarSignal | null {
  const logMessages = logs.logs;

  if (!logMessages || logMessages.length === 0) return null;

  // L1: Detect event type from log messages
  const isTradeEvent = logMessages.some((msg) =>
    PUMP_TRADE_KEYWORDS.some((keyword) => msg.includes(keyword))
  );
  const isCreateEvent = logMessages.some((msg) =>
    PUMP_CREATE_KEYWORDS.some((keyword) => msg.includes(keyword))
  );

  if (!isTradeEvent && !isCreateEvent) return null;

  // L2: Extract mint + pool/bonding-curve account from log keys.
  // Pump logs carry base58 account keys in the log line context;
  // prefer the account-keys array supplied by the RPC when available.
  const extractedData = extractPumpMintAndPool(logs);

  if (!extractedData) {
    logger.debug({ venue }, 'Could not extract pump mint/pool data from logs');
    return null;
  }

  // L3: FOMO family gate
  if (!matchesFomoFamily(extractedData.tokenMint, extractedData.creator)) {
    return null; // Not FOMO family — silent discard
  }

  // Direction heuristic: explicit sell markers → SELL, else BUY
  const direction: 'BUY' | 'SELL' = logMessages.some((msg) =>
    /\bSell\b|\bsell\b/.test(msg)
  )
    ? 'SELL'
    : 'BUY';

  return {
    tokenMint: extractedData.tokenMint,
    poolId: extractedData.poolId,
    venue,
    direction,
    detectedAt: Date.now(),
    creator: extractedData.creator,
  };
}

/**
 * Routes raw logs to the venue-specific filter.
 */
export function filterLogsByVenue(logs: Logs, venue: VenueType): RadarSignal | null {
  switch (venue) {
    case 'raydium':
      return filterRaydiumLogs(logs);
    case 'pumpfun':
    case 'pumpswap':
      return filterPumpLogs(logs, venue);
  }
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

/**
 * Extracts the token mint + pool/bonding-curve account from Pump program
 * logs. Prefers the RPC-supplied account keys; falls back to scanning
 * base58 keys embedded in log lines.
 *
 * Heuristic: first non-WSOL, non-program key is the pool/bonding-curve
 * account, second is the token mint. The optional third key is treated
 * as the creator when present.
 */
function extractPumpMintAndPool(
  logs: Logs
): { poolId: string; tokenMint: string; creator?: string } | null {
  const wsolMintBase58 = WSOL_MINT.toBase58();
  const candidates: string[] = [];

  const pushKey = (key: string): void => {
    if (key.length < 32 || key.length > 44) return;
    if (!isValidPublicKey(key)) return;
    if (key === wsolMintBase58) return; // Skip WSOL
    if (!candidates.includes(key)) candidates.push(key);
  };

  // Primary source: account keys array from the RPC notification
  // (web3.js Logs type does not carry them, but providers may attach them)
  const accountKeys = (logs as { accountKeys?: unknown }).accountKeys;
  if (Array.isArray(accountKeys)) {
    for (const key of accountKeys) {
      const base58 =
        typeof key === 'string'
          ? key
          : typeof key?.toString === 'function'
            ? String(key)
            : null;
      if (base58) pushKey(base58);
    }
  }

  // Fallback: scan embedded base58 keys in log lines
  if (candidates.length < 2) {
    for (const message of logs.logs ?? []) {
      for (const word of message.split(/\s+/)) {
        pushKey(word.replace(/[(),:;[\]]/g, ''));
      }
      if (candidates.length >= 3) break;
    }
  }

  if (candidates.length < 2) return null;

  const [poolId, tokenMint, creator] = candidates;
  return { poolId, tokenMint, creator };
}
