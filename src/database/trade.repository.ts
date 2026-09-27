import { ObjectId, type InsertOneResult } from 'mongodb';
import { getMongoDb } from './mongo.client';
import { createPendingTradeDocument, type TradeDocument } from './trade.schema';
import type { TradeDirection, TradeStatus, VenueType } from '../types/trade.types';
import { createLogger } from '../utils/logger';

const logger = createLogger('TradeRepository');
const COLLECTION_NAME = 'trades';

// ═══════════════════════════════════════════════
// INSERT Operations
// ═══════════════════════════════════════════════

/**
 * Inserts a new trade in PENDING_ON_CHAIN status.
 * Idempotent on BullMQ retries: if a document with the same jobId
 * already exists, it is marked RETRYING and its _id is reused
 * instead of throwing E11000.
 * Returns the inserted (or existing) document's _id for subsequent updates.
 */
export async function insertPendingTrade(
  jobId: string,
  tokenMint: string,
  poolId: string,
  amountSol: number,
  direction: TradeDirection,
  venue: VenueType = 'raydium'
): Promise<InsertOneResult> {
  const collection = getMongoDb().collection<TradeDocument>(COLLECTION_NAME);

  const existing = await collection.findOne({ jobId });
  if (existing) {
    await collection.updateOne({ jobId }, { $set: { status: 'RETRYING' } });
    logger.info(
      { jobId, tokenMint, direction, venue },
      'Trade already exists — marked RETRYING, reusing document'
    );
    return {
      acknowledged: true,
      insertedId: existing._id,
    } as unknown as InsertOneResult;
  }

  const document = createPendingTradeDocument(
    jobId, tokenMint, poolId, amountSol, direction, venue
  );

  const result = await collection.insertOne(document);

  logger.info(
    { jobId, tokenMint, direction, venue },
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
  statusFilter?: TradeStatus
): Promise<TradeDocument[]> {
  const query = statusFilter ? { status: statusFilter } : {};

  return getMongoDb()
    .collection<TradeDocument>(COLLECTION_NAME)
    .find(query)
    .sort({ createdAt: -1 })
    .limit(maxResults)
    .toArray();
}
