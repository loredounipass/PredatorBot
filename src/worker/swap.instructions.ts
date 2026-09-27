import { Api, makeSwapFixedInInstruction } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import {
  Connection,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import { RAYDIUM_V4_PROGRAM_ID } from '../config/constants';
import { getOrCreateATAInstruction } from '../wallet/ata.manager';
import { isValidPublicKey } from '../utils/sol.helpers';
import { createLogger } from '../utils/logger';
import { PredatorError, PredatorErrorCode } from '../types/system.types';
import type { TradeDirection } from '../types/trade.types';
import { getSplBalanceRaw } from '../utils/sol.helpers';

const logger = createLogger('SwapInstructions');

/**
 * Minimal V4 pool-keys shape consumed by makeSwapFixedInInstruction.
 * Sourced from Raydium API fetchPoolKeysById (cached) and validated
 * against the V4 program id. Withdraw/lp-vault fields are intentionally
 * omitted — the fixed-in swap instruction never reads them.
 */
export interface RaydiumV4PoolKeys {
  readonly poolId: string;
  readonly baseMint: PublicKey;
  readonly quoteMint: PublicKey;
  /** SPL token account holding the base-side liquidity. */
  readonly baseVault: PublicKey;
  /** SPL token account holding the quote-side liquidity. */
  readonly quoteVault: PublicKey;
  readonly rawKeys: unknown;
}

let raydiumApi: Api | null = null;
const poolKeysCache = new Map<string, RaydiumV4PoolKeys>();

function getApi(): Api {
  if (!raydiumApi) raydiumApi = new Api({ cluster: 'mainnet', timeout: 10_000 });
  return raydiumApi;
}

/**
 * Fetches (and caches) Raydium pool keys for a V4 pool id.
 * Pool keys are immutable on-chain, so caching forever is safe —
 * this keeps per-trade latency to zero RPC/API calls after warmup.
 *
 * @throws VENUE_UNSUPPORTED when the pool is not owned by the V4 program
 * @throws POOL_NOT_FOUND when the API has no keys for the id
 */
export async function getRaydiumPoolKeys(poolId: string): Promise<RaydiumV4PoolKeys> {
  const cached = poolKeysCache.get(poolId);
  if (cached) return cached;

  if (!isValidPublicKey(poolId)) {
    throw new PredatorError(PredatorErrorCode.POOL_NOT_FOUND, `Invalid pool id: ${poolId}`, {
      poolId,
    });
  }

  const result = await getApi().fetchPoolKeysById({ idList: [poolId] });
  const raw = (Array.isArray(result) ? result[0] : result) as unknown as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new PredatorError(
      PredatorErrorCode.POOL_NOT_FOUND,
      `No Raydium pool keys found for id: ${poolId}`,
      { poolId }
    );
  }

  const programId = String(raw['programId']);
  if (programId !== RAYDIUM_V4_PROGRAM_ID.toBase58()) {
    throw new PredatorError(
      PredatorErrorCode.VENUE_UNSUPPORTED,
      `Pool ${poolId} is not a Raydium V4 pool (program ${programId}) — ` +
        'CLMM/CPMM layouts need their own decoder and swap builder',
      { poolId, programId, venue: 'raydium' }
    );
  }

  const mintA = raw['mintA'] as { address: string };
  const mintB = raw['mintB'] as { address: string };
  const vault = raw['vault'] as { A: string; B: string };

  if (!vault?.A || !vault?.B) {
    throw new PredatorError(
      PredatorErrorCode.POOL_NOT_FOUND,
      `Pool keys for ${poolId} are missing vault accounts`,
      { poolId }
    );
  }

  const keys: RaydiumV4PoolKeys = {
    poolId,
    baseMint: new PublicKey(mintA.address),
    quoteMint: new PublicKey(mintB.address),
    baseVault: new PublicKey(vault.A),
    quoteVault: new PublicKey(vault.B),
    rawKeys: raw,
  };

  poolKeysCache.set(poolId, keys);
  logger.info({ poolId }, 'Raydium V4 pool keys cached');

  return keys;
}

/**
 * Reads the wallet's raw token balance (base units). Returns 0n when the
 * ATA does not exist.
 */
export async function getTokenBalanceRaw(
  connection: Connection,
  wallet: PublicKey,
  tokenMint: PublicKey
): Promise<{ ata: PublicKey; balanceRaw: bigint }> {
  const { ataAddress } = await getOrCreateATAInstruction(connection, wallet, tokenMint);

  // getAccountInfo-based read: indexed getTokenAccountBalance is blocked
  // by free RPC tiers.
  const balanceRaw = await getSplBalanceRaw(connection, ataAddress);

  return { ata: ataAddress, balanceRaw };
}

/**
 * Resolves the SELL amount in token base units: the SOL-notional worth of
 * tokens at spot price, capped at the wallet balance.
 */
export function resolveSellAmountRaw(
  balanceRaw: bigint,
  amountSolLamports: bigint,
  tokenReserveRaw: bigint,
  solReserveRaw: bigint
): bigint {
  if (balanceRaw <= 0n) {
    throw new PredatorError(
      PredatorErrorCode.INSUFFICIENT_BALANCE,
      'Nothing to sell — token balance is zero',
      {}
    );
  }
  if (solReserveRaw <= 0n || tokenReserveRaw <= 0n) {
    throw new PredatorError(PredatorErrorCode.POOL_NOT_FOUND, 'Pool has no liquidity', {});
  }

  const desiredRaw = (amountSolLamports * tokenReserveRaw) / solReserveRaw;
  const amountRaw = desiredRaw > balanceRaw ? balanceRaw : desiredRaw;

  if (amountRaw <= 0n) {
    throw new PredatorError(
      PredatorErrorCode.INSUFFICIENT_BALANCE,
      'SELL amount resolves to zero — balance below trade size',
      { balanceRaw: balanceRaw.toString() }
    );
  }

  return amountRaw;
}

export interface SwapBuildInput {
  readonly connection: Connection;
  readonly wallet: PublicKey;
  readonly poolKeys: RaydiumV4PoolKeys;
  readonly tokenMint: PublicKey;
  readonly direction: TradeDirection;
  readonly amountInRaw: bigint;
  readonly minimumAmountOutRaw: bigint;
}

/**
 * Builds the FULL instruction sequence for a Raydium V4 fixed-in swap:
 *   BUY  (SOL → token): [create ATAs?] + wrap SOL → WSOL + swap
 *   SELL (token → SOL): [create WSOL ATA?] + swap + unwrap (close WSOL ATA)
 *
 * No on-chain simulation / preflight here by design (HFT: every extra
 * round-trip costs fills). Slippage protection is enforced on-chain via
 * minimumAmountOut. Reverted transactions still cost fees.
 */
export async function buildRaydiumV4SwapInstructions(
  input: SwapBuildInput
): Promise<TransactionInstruction[]> {
  const { connection, wallet, poolKeys, tokenMint, direction, amountInRaw, minimumAmountOutRaw } =
    input;

  const instructions: TransactionInstruction[] = [];

  // Ensure both ATAs exist (creation ixs are prepended when needed)
  const tokenAta = await getOrCreateATAInstruction(connection, wallet, tokenMint);
  if (tokenAta.instruction) instructions.push(tokenAta.instruction);

  const wsolAta = await getOrCreateATAInstruction(connection, wallet, NATIVE_MINT);
  if (wsolAta.instruction) instructions.push(wsolAta.instruction);

  const isBuy = direction === 'BUY';
  const sourceAta = isBuy ? wsolAta.ataAddress : tokenAta.ataAddress;
  const destAta = isBuy ? tokenAta.ataAddress : wsolAta.ataAddress;

  if (isBuy) {
    // Wrap SOL → WSOL so the AMM can pull it
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: wallet,
        toPubkey: wsolAta.ataAddress,
        lamports: amountInRaw,
      })
    );
    instructions.push(createSyncNativeInstruction(wsolAta.ataAddress));
  }

  // Core V4 fixed-in swap instruction
  const swapIx = makeSwapFixedInInstruction(
    {
      poolKeys: poolKeys.rawKeys as never,
      userKeys: {
        tokenAccountIn: sourceAta,
        tokenAccountOut: destAta,
        owner: wallet,
      },
      amountIn: new BN(amountInRaw.toString()),
      minAmountOut: new BN(minimumAmountOutRaw.toString()),
    },
    4 // pool version: AMM V4
  );
  instructions.push(swapIx);

  if (!isBuy) {
    // Unwrap WSOL → SOL back to the wallet
    instructions.push(
      createCloseAccountInstruction(wsolAta.ataAddress, wallet, wallet)
    );
  }

  logger.info(
    {
      poolId: poolKeys.poolId,
      direction,
      amountIn: amountInRaw.toString(),
      minimumAmountOut: minimumAmountOutRaw.toString(),
      instructionCount: instructions.length,
    },
    'Raydium V4 swap instructions built'
  );

  return instructions;
}
