import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadEnvironment } from '../config/environment';
import { createLogger } from '../utils/logger';
import { PredatorError, PredatorErrorCode } from '../types/system.types';

const logger = createLogger('WalletLoader');

let cachedKeypair: Keypair | null = null;

/**
 * Loads the trading wallet Keypair from the PREDATOR_WALLET_PRIVATE_KEY env var.
 *
 * Supports two formats:
 *   1. Base58-encoded string (standard Phantom/CLI export)
 *   2. JSON array of 64 bytes (Solana CLI `id.json` format)
 *
 * Caches the result — safe to call multiple times.
 */
export function loadWalletKeypair(): Keypair {
  if (cachedKeypair) return cachedKeypair;

  const config = loadEnvironment();
  const rawKey = config.PREDATOR_WALLET_PRIVATE_KEY;

  try {
    let secretKey: Uint8Array;

    // Detect format: JSON array starts with '[', otherwise assume base58
    if (rawKey.startsWith('[')) {
      const parsedArray: number[] = JSON.parse(rawKey);

      if (parsedArray.length !== 64) {
        throw new Error(`Expected 64 bytes, received ${parsedArray.length}`);
      }

      secretKey = Uint8Array.from(parsedArray);
    } else {
      secretKey = bs58.decode(rawKey);
    }

    cachedKeypair = Keypair.fromSecretKey(secretKey);

    logger.info(
      { publicKey: cachedKeypair.publicKey.toBase58() },
      'Wallet loaded successfully'
    );

    return cachedKeypair;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new PredatorError(
      PredatorErrorCode.WALLET_LOAD_FAILED,
      `Failed to load wallet keypair: ${message}`,
      { hint: 'Ensure PREDATOR_WALLET_PRIVATE_KEY is a valid base58 or JSON array' }
    );
  }
}

/**
 * Returns the wallet's public key as a base58 string.
 * Convenience wrapper for display/logging.
 */
export function getWalletPublicKeyBase58(): string {
  return loadWalletKeypair().publicKey.toBase58();
}
