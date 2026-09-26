import { ObjectId, type InsertOneResult } from 'mongodb';
import { getMongoDb } from './mongo.client';
import { createPendingTradeDocument, type TradeDocument } from './trade.schema';
import type { TradeDirection } from '../types/trade.types';
import { createLogger } from '../utils/logger';

const logger = createLogger('TradeRepository');
const COLLECTION_NAME = 'trades';

// ═══════════════════════════════════════════════
// INSERT Operations
// ═══════════════════════════════════════════════

/**
 * Inserts a new trade in PENDING_ON_CHAIN status.
 * Returns the inserted document's _id for subsequent updates.
 */
export async function insertPendingTrade(
  jobId: string,
  tokenMint: string,
  poolId: string,
  amountSol: number,
  direction: TradeDirection
): Promise<InsertOneResult> {
  const document = createPendingTradeDocument(
    jobId, tokenMint, poolId, amountSol, direction
  );

  const result = await getMongoDb()
    .collection<TradeDocument>(COLLECTION_NAME)
    .insertOne(document);

  logger.info(
    { jobId, tokenMint, direction },
    'Trade pre-flight record inserted (PENDING_ON_CHAIN)'
  );

  return result;
}

// ═══════════════════════════════════════════════
// UPDATE Operations
// ═══════════════════════════════════════════════

/**
 * Marks a trade as COMPLETED with execution details.
 */
export async function markTradeCompleted(
  documentId: ObjectId,
  txSignature: string,
  executionPriceSol: number,
  slippageBps: number,
  priorityFeeMicroLamports: number
): Promise<void> {
  await getMongoDb()
    .collection<TradeDocument>(COLLECTION_NAME)
    .updateOne(
      { _id: documentId },
      {
        $set: {
          status: 'COMPLETED',
          txSignature,
          executionPriceSol,
          slippageBps,
          priorityFeeMicroLamports,
          completedAt: new Date(),
        },
      }
    );

  logger.info({ txSignature }, 'Trade marked COMPLETED');
}

/**
 * Marks a trade as FAILED with the failure reason.
 */
export async function markTradeFailed(
  documentId: ObjectId,
  failureReason: string
): Promise<void> {
  await getMongoDb()
    .collection<TradeDocument>(COLLECTION_NAME)
    .updateOne(
      { _id: documentId },
      {
        $set: {
          status: 'FAILED',
          failureReason,
          completedAt: new Date(),
        },
      }
    );

  logger.warn({ failureReason }, 'Trade marked FAILED');
}

/**
 * Marks a trade as RETRYING (intermediate state before next attempt).
 */
export async function markTradeRetrying(documentId: ObjectId): Promise<void> {
  await getMongoDb()
    .collection<TradeDocument>(COLLECTION_NAME)
    .updateOne(
      { _id: documentId },
      { $set: { status: 'RETRYING' } }
    );
}

// ═══════════════════════════════════════════════
// QUERY Operations
// ═══════════════════════════════════════════════

/**
 * Finds a trade by its BullMQ job ID.
 */
export async function findTradeByJobId(
  jobId: string
): Promise<TradeDocument | null> {
  return getMongoDb()
    .collection<TradeDocument>(COLLECTION_NAME)
    .findOne({ jobId });
}

/**
 * Retrieves recent trades with optional status filter.
 * Returns newest first, limited to `maxResults`.
 */
export async function findRecentTrades(
  maxResults: number = 50,
  statusFilter?: string
): Promise<TradeDocument[]> {
  const query = statusFilter ? { status: statusFilter } : {};

  return getMongoDb()
    .collection<TradeDocument>(COLLECTION_NAME)
    .find(query)
    .sort({ createdAt: -1 })
    .limit(maxResults)
    .toArray();
}
