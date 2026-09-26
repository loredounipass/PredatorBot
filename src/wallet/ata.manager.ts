import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Connection,
  PublicKey,
  type TransactionInstruction,
} from '@solana/web3.js';
import { createLogger } from '../utils/logger';
import { PredatorError, PredatorErrorCode } from '../types/system.types';

const logger = createLogger('ATAManager');

/**
 * Derives the Associated Token Account (ATA) address for a given wallet and mint.
 * This is a pure derivation — does not check if the account exists on-chain.
 *
 * @param walletPublicKey - Owner wallet public key
 * @param tokenMint       - SPL token mint address
 * @returns Derived ATA public key
 */
export function deriveATAAddress(
  walletPublicKey: PublicKey,
  tokenMint: PublicKey
): PublicKey {
  return getAssociatedTokenAddressSync(
    tokenMint,
    walletPublicKey,
    false, // allowOwnerOffCurve
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

/**
 * Checks if an ATA exists on-chain. If not, returns the instruction to create it.
 * This avoids a separate transaction for ATA creation — the instruction can be
 * prepended to the swap transaction.
 *
 * @param connection      - Solana RPC connection
 * @param walletPublicKey - Owner wallet public key
 * @param tokenMint       - SPL token mint address
 * @returns Instruction to create ATA, or null if it already exists
 */
export async function getOrCreateATAInstruction(
  connection: Connection,
  walletPublicKey: PublicKey,
  tokenMint: PublicKey
): Promise<{ ataAddress: PublicKey; instruction: TransactionInstruction | null }> {
  const ataAddress = deriveATAAddress(walletPublicKey, tokenMint);

  try {
    const accountInfo = await connection.getAccountInfo(ataAddress);

    if (accountInfo !== null) {
      logger.debug(
        { ata: ataAddress.toBase58(), mint: tokenMint.toBase58() },
        'ATA already exists'
      );
      return { ataAddress, instruction: null };
    }

    logger.info(
      { ata: ataAddress.toBase58(), mint: tokenMint.toBase58() },
      'ATA does not exist — creating instruction'
    );

    const createATAIx = createAssociatedTokenAccountInstruction(
      walletPublicKey,  // payer
      ataAddress,       // associatedToken
      walletPublicKey,  // owner
      tokenMint,        // mint
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    return { ataAddress, instruction: createATAIx };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new PredatorError(
      PredatorErrorCode.ATA_CREATION_FAILED,
      `Failed to resolve ATA for mint ${tokenMint.toBase58()}: ${message}`,
      { ataAddress: ataAddress.toBase58() }
    );
  }
}
