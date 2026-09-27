import { Connection, PublicKey } from '@solana/web3.js';
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import { PUMP_PROGRAM_ID, SOLANA_COMMITMENT } from '../config/constants';
import { createLogger } from '../utils/logger';
import { PredatorError, PredatorErrorCode } from '../types/system.types';
import type { LiquiditySnapshot, PoolReserves } from '../types/pool.types';
import type { VenueType } from '../types/trade.types';
import { getRaydiumPoolKeys } from './swap.instructions';
import { getSplBalanceRaw } from '../utils/sol.helpers';

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
 * Routes decoding by venue: Raydium AMM V4 layout, Pump.fun bonding-curve
 * layout, or PumpSwap AMM (decode pending — see fetchPumpSwapSnapshot).
 *
 * @param connection - Solana RPC connection
 * @param poolId     - Base58 pool / bonding-curve account address
 * @param tokenMint  - Target token mint for snapshot labeling
 * @param venue      - Execution venue (defaults to raydium for legacy jobs)
 */
export async function fetchPoolSnapshot(
  connection: Connection,
  poolId: string,
  tokenMint: string,
  venue: VenueType = 'raydium'
): Promise<LiquiditySnapshot> {
  switch (venue) {
    case 'pumpfun':
      return fetchPumpBondingCurveSnapshot(connection, poolId, tokenMint);
    case 'pumpswap':
      return fetchPumpSwapSnapshot(connection, poolId, tokenMint);
    case 'raydium':
      return fetchRaydiumSnapshot(connection, poolId, tokenMint);
  }
}

/**
 * Raydium AMM V4 snapshot (original path, unchanged semantics).
 *
 * Reserves are read from the pool's vault token accounts (authoritative
 * balances), NOT from fixed offsets in the pool state account.
 */
async function fetchRaydiumSnapshot(
  connection: Connection,
  poolId: string,
  tokenMint: string
): Promise<LiquiditySnapshot> {
  try {
    const keys = await getRaydiumPoolKeys(poolId);

    // Vault balances via getAccountInfo (non-indexed) — free RPCs reject
    // the indexed getTokenAccountBalance method.
    const [baseReserve, quoteReserve] = await Promise.all([
      getSplBalanceRaw(connection, keys.baseVault),
      getSplBalanceRaw(connection, keys.quoteVault),
    ]);

    if (baseReserve === 0n && quoteReserve === 0n) {
      throw new PredatorError(
        PredatorErrorCode.POOL_NOT_FOUND,
        `Pool ${poolId} vaults are empty or unreadable`,
        { poolId, tokenMint }
      );
    }

    // Orient: baseReserve is ALWAYS the target-token side.
    const tokenMintPk = new PublicKey(tokenMint);
    const baseIsToken = keys.baseMint.equals(tokenMintPk);

    if (!baseIsToken && !keys.quoteMint.equals(tokenMintPk)) {
      throw new PredatorError(
        PredatorErrorCode.POOL_NOT_FOUND,
        `Token ${tokenMint} is not part of pool ${poolId}`,
        { poolId, tokenMint }
      );
    }

    const reserves: PoolReserves = {
      baseReserve: baseIsToken ? baseReserve : quoteReserve,
      quoteReserve: baseIsToken ? quoteReserve : baseReserve,
      lpSupply: 0n, // Not needed for fixed-in simulation
      poolOpenTime: 0,
    };

    const snapshot: LiquiditySnapshot = {
      poolId,
      tokenMint,
      venue: 'raydium',
      reserves,
      fetchedAt: Date.now(),
    };

    logger.info(
      {
        venue: 'raydium',
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
 * Pump.fun bonding-curve snapshot.
 *
 * BondingCurve account layout (Anchor, pump program IDL):
 *   discriminator (8) | virtualTokenReserves u64 (8) |
 *   virtualSolReserves u64 (16) | realTokenReserves u64 (24) |
 *   realSolReserves u64 (32) | tokenTotalSupply u64 (40) |
 *   complete bool (48)
 *
 * Virtual reserves drive the constant-product pricing, so they map to
 * base/quote for the shared slippage simulator. `complete === true`
 * means the token graduated to PumpSwap and this curve is dead.
 */
async function fetchPumpBondingCurveSnapshot(
  connection: Connection,
  poolId: string,
  tokenMint: string
): Promise<LiquiditySnapshot> {
  const curvePublicKey = new PublicKey(poolId);

  const accountInfo = await connection.getAccountInfo(
    curvePublicKey,
    SOLANA_COMMITMENT
  );

  if (!accountInfo || !accountInfo.data) {
    throw new PredatorError(
      PredatorErrorCode.POOL_NOT_FOUND,
      `Bonding curve account not found: ${poolId}`,
      { poolId, tokenMint, venue: 'pumpfun' }
    );
  }

  if (!accountInfo.owner.equals(PUMP_PROGRAM_ID)) {
    throw new PredatorError(
      PredatorErrorCode.POOL_NOT_FOUND,
      `Account ${poolId} is not owned by the Pump.fun program`,
      {
        poolId,
        tokenMint,
        venue: 'pumpfun',
        owner: accountInfo.owner.toBase58(),
      }
    );
  }

  const data = accountInfo.data;
  if (data.length < 49) {
    throw new PredatorError(
      PredatorErrorCode.POOL_NOT_FOUND,
      `Bonding curve account data too short (${data.length} bytes): ${poolId}`,
      { poolId, tokenMint, venue: 'pumpfun' }
    );
  }

  const virtualTokenReserves = data.readBigUInt64LE(8);
  const virtualSolReserves = data.readBigUInt64LE(16);
  const tokenTotalSupply = data.readBigUInt64LE(40);
  const complete = data[48] === 1;

  const snapshot: LiquiditySnapshot = {
    poolId,
    tokenMint,
    venue: 'pumpfun',
    reserves: {
      baseReserve: virtualTokenReserves,
      quoteReserve: virtualSolReserves,
      lpSupply: tokenTotalSupply,
      poolOpenTime: 0,
    },
    fetchedAt: Date.now(),
    complete,
  };

  logger.info(
    {
      venue: 'pumpfun',
      poolId,
      baseReserve: virtualTokenReserves.toString(),
      quoteReserve: virtualSolReserves.toString(),
      complete,
    },
    'Bonding curve snapshot fetched'
  );

  return snapshot;
}

/**
 * PumpSwap AMM snapshot (graduated tokens).
 *
 * NOT YET IMPLEMENTED: PumpSwap pool reserve decoding requires the
 * PumpSwap AMM IDL account layout to be wired in (dependency:
 * @pump-fun/pump-swap-sdk or equivalent). Fails fast with a clear
 * VENUE_UNSUPPORTED error instead of trading on mis-decoded reserves.
 */
async function fetchPumpSwapSnapshot(
  connection: Connection,
  poolId: string,
  tokenMint: string
): Promise<LiquiditySnapshot> {
  // Existence check only — no trading on unverified layouts.
  const accountInfo = await connection.getAccountInfo(
    new PublicKey(poolId),
    SOLANA_COMMITMENT
  );

  if (!accountInfo || !accountInfo.data) {
    throw new PredatorError(
      PredatorErrorCode.POOL_NOT_FOUND,
      `PumpSwap pool account not found: ${poolId}`,
      { poolId, tokenMint, venue: 'pumpswap' }
    );
  }

  throw new PredatorError(
    PredatorErrorCode.VENUE_UNSUPPORTED,
    'PumpSwap reserve decoding is not wired yet — wire the PumpSwap AMM IDL ' +
      `layout (pool ${poolId}) before trading graduated tokens. ` +
      'Bonding-curve (pumpfun venue) snapshots are supported.',
    { poolId, tokenMint, venue: 'pumpswap' }
  );
}
