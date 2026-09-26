import { MongoClient, Db } from 'mongodb';
import { loadEnvironment } from '../config/environment';
import { createLogger } from '../utils/logger';

const logger = createLogger('MongoClient');

let mongoClient: MongoClient | null = null;
let mongoDb: Db | null = null;

/**
 * Initializes the MongoDB connection and bootstraps required indexes.
 * Returns the database instance for the PredatorBot ledger.
 */
export async function initMongoClient(): Promise<Db> {
  if (mongoDb) return mongoDb;

  const config = loadEnvironment();

  mongoClient = new MongoClient(config.MONGO_URI, {
    maxPoolSize: 10,
    minPoolSize: 2,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
  });

  await mongoClient.connect();
  mongoDb = mongoClient.db(config.MONGO_DB_NAME);

  await bootstrapIndexes(mongoDb);

  logger.info(
    { database: config.MONGO_DB_NAME },
    'MongoDB Ledger Core online & indexed'
  );

  return mongoDb;
}

/**
 * Creates required indexes for O(1)/O(log n) query performance.
 * Uses `createIndex` with idempotent behavior — safe to call on every boot.
 */
async function bootstrapIndexes(db: Db): Promise<void> {
  const tradesCollection = db.collection('trades');

  await Promise.all([
    tradesCollection.createIndex({ tokenMint: 1 }),
    tradesCollection.createIndex({ txSignature: 1 }, { unique: true, sparse: true }),
    tradesCollection.createIndex({ status: 1, createdAt: -1 }),
    tradesCollection.createIndex({ jobId: 1 }, { unique: true }),
  ]);

  logger.info('MongoDB indexes bootstrapped (4 indexes on trades collection)');
}

/**
 * Returns the cached database instance.
 * Throws if called before initMongoClient().
 */
export function getMongoDb(): Db {
  if (!mongoDb) {
    throw new Error('MongoDB not initialized — call initMongoClient() first');
  }
  return mongoDb;
}

/**
 * Gracefully closes the MongoDB connection.
 */
export async function disconnectMongo(): Promise<void> {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    mongoDb = null;
    logger.info('MongoDB disconnected gracefully');
  }
}
