import {
  Connection,
  Keypair,
  VersionedTransaction,
  SendTransactionError,
} from '@solana/web3.js';
import { SOLANA_COMMITMENT } from '../config/constants';
import { createLogger } from '../utils/logger';
import { PredatorError, PredatorErrorCode } from '../types/system.types';
import { truncateSignature } from '../utils/sol.helpers';

const logger = createLogger('TransactionSigner');

/** Result of a signed and dispatched transaction */
export interface TransactionDispatchResult {
  readonly txSignature: string;
  readonly confirmationSlot: number;
}

/**
 * Signs a VersionedTransaction with the provided keypair and dispatches
 * it to the Solana network via the RPC connection.
 *
 * Waits for confirmation at the configured commitment level.
 *
 * @param connection  - Solana RPC connection (Alchemy endpoint)
 * @param transaction - Assembled unsigned VersionedTransaction
 * @param signer      - Wallet Keypair for signing
 * @returns Transaction signature and confirmation slot
 */
export async function signAndDispatchTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
  signer: Keypair
): Promise<TransactionDispatchResult> {
  // Sign the transaction
  transaction.sign([signer]);

  logger.info('Transaction signed — dispatching to Solana network...');

  // Capture blockhash context BEFORE send — reusing the same
  // lastValidBlockHeight for confirmTransaction. Fetching it after
  // send (previous behavior) mismatches on slow/public RPCs and
  // causes spurious "block height exceeded" expiries.
  const recentBlockhash = transaction.message.recentBlockhash;
  const { lastValidBlockHeight } = await connection.getLatestBlockhash(
    SOLANA_COMMITMENT
  );

  try {
    // Send with skip preflight for speed (we already simulated)
    const txSignature = await connection.sendTransaction(transaction, {
      skipPreflight: true,
      maxRetries: 5,
      preflightCommitment: SOLANA_COMMITMENT,
    });

    logger.info(
      { txSignature: truncateSignature(txSignature) },
      'Transaction dispatched — awaiting confirmation'
    );

    // Wait for confirmation — reuse pre-send blockhash context
    const confirmation = await connection.confirmTransaction(
      {
        signature: txSignature,
        blockhash: recentBlockhash,
        lastValidBlockHeight,
      },
      SOLANA_COMMITMENT
    );

    if (confirmation.value.err) {
      throw new PredatorError(
        PredatorErrorCode.TX_SEND_FAILED,
        `Transaction confirmed with error: ${JSON.stringify(confirmation.value.err)}`,
        { txSignature }
      );
    }

    const confirmationSlot = confirmation.context.slot;

    logger.info(
      {
        txSignature: truncateSignature(txSignature),
        slot: confirmationSlot,
      },
      'Transaction confirmed on-chain'
    );

    return { txSignature, confirmationSlot };
  } catch (error: unknown) {
    if (error instanceof PredatorError) throw error;

    const message =
      error instanceof SendTransactionError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unknown dispatch error';

    throw new PredatorError(
      PredatorErrorCode.TX_SEND_FAILED,
      `Transaction dispatch failed: ${message}`,
      { errorType: error?.constructor?.name }
    );
  }
}
