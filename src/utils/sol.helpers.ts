import { PublicKey } from '@solana/web3.js';
import { LAMPORTS_PER_SOL } from '../config/constants';

/**
 * Converts SOL amount to lamports (bigint).
 * 1 SOL = 1,000,000,000 lamports.
 *
 * @param sol - Amount in SOL (e.g., 1.25)
 * @returns Equivalent amount in lamports as bigint
 */
export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

/**
 * Converts lamports to SOL amount (number).
 *
 * @param lamports - Amount in lamports (bigint)
 * @returns Equivalent amount in SOL as floating point
 */
export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/**
 * Validates whether a string is a valid Solana base58 public key.
 *
 * @param address - Candidate public key string
 * @returns True if the string is a valid PublicKey
 */
export function isValidPublicKey(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely parses a string into a Solana PublicKey.
 * Throws a descriptive error if parsing fails.
 *
 * @param address - Base58-encoded public key string
 * @param label   - Human-readable label for error context (e.g., 'tokenMint')
 * @returns Parsed PublicKey instance
 */
export function parsePublicKey(address: string, label: string): PublicKey {
  try {
    return new PublicKey(address);
  } catch {
    throw new Error(`Invalid PublicKey for "${label}": ${address}`);
  }
}

/**
 * Formats a transaction signature for display (truncated).
 *
 * @param signature - Full base58 transaction signature
 * @returns Truncated signature string (e.g., "3N4fGk...x7Rp")
 */
export function truncateSignature(signature: string): string {
  if (signature.length <= 12) return signature;
  return `${signature.slice(0, 6)}...${signature.slice(-4)}`;
}

/**
 * Reads a raw SPL token balance via getAccountInfo (non-indexed RPC).
 *
 * Uses getTokenAccountBalance internally would be simpler, but free
 * public RPCs (e.g. publicnode) reject indexed methods with 403.
 * getAccountInfo works everywhere: SPL Token Account layout holds
 * the amount as u64 LE at offset 64 (mint[0..32] + owner[32..64]).
 *
 * Returns 0n when the account does not exist.
 */
export async function getSplBalanceRaw(
  connection: import('@solana/web3.js').Connection,
  tokenAccount: import('@solana/web3.js').PublicKey
): Promise<bigint> {
  const info = await connection.getAccountInfo(tokenAccount);

  if (!info || !info.data || info.data.length < 72) return 0n;

  return info.data.readBigUInt64LE(64);
}

/**
 * Fetches the decimals of an SPL mint via parsed RPC account info.
 *
 * @param connection - Solana RPC connection
 * @param mint - Mint public key
 * @returns Number of decimals for token
 */
export async function fetchMintDecimals(
  connection: import('@solana/web3.js').Connection,
  mint: import('@solana/web3.js').PublicKey
): Promise<number> {
  const accountInfo = await connection.getParsedAccountInfo(mint);
  const parsed = (accountInfo.value?.data as any)?.parsed;
  if (!parsed || parsed.type !== 'mint' || parsed.info?.decimals === undefined) {
    throw new Error(`Unable to fetch mint decimals for ${mint.toBase58()}`);
  }
  return Number(parsed.info.decimals);
}
