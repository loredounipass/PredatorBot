import { Connection, PublicKey } from '@solana/web3.js';
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import { loadEnvironment } from '../config/environment';
import { SOLANA_COMMITMENT } from '../config/constants';
import { createLogger } from '../utils/logger';
import { PredatorError, PredatorErrorCode } from '../types/system.types';
import type { LiquiditySnapshot, PoolReserves } from '../types/pool.types';

const logger = createLogger('PoolEngine');

let raydiumClient: Raydium | null = null;

/**
 * Initializes (or returns cached) Raydium SDK client.
 * The SDK handles pool data fetching, AMM math, and swap layout generation.
 */
export async function getRaydiumClient(
  connection: Connection,
  ownerKeypair: import('@solana/web3.js').Keypair
): Promise<Raydium> {
  if (raydiumClient) return raydiumClient;

  raydiumClient = await Raydium.load({
    connection,
    owner: ownerKeypair,
    cluster: 'mainnet',
    disableFeatureCheck: true,
    disableLoadToken: true, // We manage tokens manually for speed
  });

  logger.info('Raydium SDK client initialized');
  return raydiumClient;
}

/**
 * Fetches the current pool data for a given pool ID from on-chain state.
 * Returns a typed LiquiditySnapshot with reserve amounts and metadata.
 *
 * @param connection - Solana RPC connection
 * @param poolId     - Base58 Raydium AMM pool address
 * @param tokenMint  - Target token mint for snapshot labeling
 */
export async function fetchPoolSnapshot(
  connection: Connection,
  poolId: string,
  tokenMint: string
): Promise<LiquiditySnapshot> {
  const poolPublicKey = new PublicKey(poolId);

  try {
    const accountInfo = await connection.getAccountInfo(
      poolPublicKey,
      SOLANA_COMMITMENT
    );

    if (!accountInfo || !accountInfo.data) {
      throw new PredatorError(
        PredatorErrorCode.POOL_NOT_FOUND,
        `Pool account not found: ${poolId}`,
        { poolId }
      );
    }

    // Decode pool account data using Raydium AMM layout
    // The exact decoding depends on the Raydium SDK version
    const reserves = decodePoolReserves(accountInfo.data);

    const snapshot: LiquiditySnapshot = {
      poolId,
      tokenMint,
      reserves,
      fetchedAt: Date.now(),
    };

    logger.info(
      {
        poolId,
        baseReserve: reserves.baseReserve.toString(),
        quoteReserve: reserves.quoteReserve.toString(),
      },
      'Pool snapshot fetched'
    );

    return snapshot;
  } catch (error: unknown) {
    if (error instanceof PredatorError) throw error;

    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new PredatorError(
      PredatorErrorCode.POOL_NOT_FOUND,
      `Failed to fetch pool data for ${poolId}: ${message}`,
      { poolId, tokenMint }
    );
  }
}

/**
 * Decodes raw pool account buffer into typed PoolReserves.
 * Uses fixed byte offsets from the Raydium AMM V4 account layout.
 *
 * Layout offsets (Raydium V4):
 *   - baseReserve:  offset 128, 8 bytes (u64 LE)
 *   - quoteReserve: offset 136, 8 bytes (u64 LE)
 *   - lpSupply:     offset 272, 8 bytes (u64 LE)
 *   - poolOpenTime: offset 280, 8 bytes (u64 LE)
 */
function decodePoolReserves(data: Buffer): PoolReserves {
  const baseReserve = data.readBigUInt64LE(128);
  const quoteReserve = data.readBigUInt64LE(136);
  const lpSupply = data.readBigUInt64LE(272);
  const poolOpenTime = Number(data.readBigUInt64LE(280));

  return {
    baseReserve,
    quoteReserve,
    lpSupply,
    poolOpenTime,
  };
}
