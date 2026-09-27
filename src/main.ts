import { loadEnvironment, getFomoMintAllowlist } from './config/environment';
import { TARGET_TOKEN_MINT } from './config/constants';
import { createRedisConnection, disconnectRedis } from './config/redis.config';
import { initMongoClient, disconnectMongo } from './database/mongo.client';
import { initExecutionQueue, closeExecutionQueue } from './queue/queue.manager';
import { attachQueueEventHandlers } from './queue/queue.events';
import { loadWalletKeypair } from './wallet/wallet.loader';
import { spawnPredatorWorker, closePredatorWorker } from './worker/predator.worker';
import { startRadarListener, stopRadarListener } from './radar/radar.listener';
import { startApiServer } from './api/server';
import { createLogger } from './utils/logger';

const logger = createLogger('Main');

// ═══════════════════════════════════════════════
// Bootstrap Sequence
// ═══════════════════════════════════════════════

async function bootstrap(): Promise<void> {
  logger.info('═══════════════════════════════════════════');
  logger.info('   🐺 PredatorBot — Initialization');
  logger.info('═══════════════════════════════════════════');

  // Step 1: Load & validate environment
  const config = loadEnvironment();
  logger.info('✔ Environment validated');

  // Step 2: Initialize Redis connection
  createRedisConnection();
  logger.info('✔ Redis connection established');

  // Step 3: Initialize MongoDB + indexes
  await initMongoClient();
  logger.info('✔ MongoDB Ledger Core online');

  // Step 4: Load wallet keypair
  const wallet = loadWalletKeypair();
  logger.info(
    { publicKey: wallet.publicKey.toBase58() },
    '✔ Wallet loaded'
  );

  // Step 5: Initialize BullMQ execution queue
  const queue = initExecutionQueue();
  attachQueueEventHandlers(queue);
  logger.info('✔ Execution queue initialized');

  // Step 6: Spawn PredatorWorker (BullMQ consumer)
  spawnPredatorWorker();
  logger.info('✔ PredatorWorker spawned');

  // Step 7: Start Radar listener (WebSocket)
  startRadarListener();
  logger.info('✔ Radar listener active');

  // Step 8: HTTP API + React UI (replaces CLI for manual trades)
  startApiServer();
  logger.info('✔ API+UI server active');

  logger.info('═══════════════════════════════════════════');
  logger.info('   🟢 PredatorBot LIVE — Hunting Active');
  logger.info(`   📡 Scanning Raydium V4 + Pump.fun + PumpSwap via Alchemy WSS`);
  logger.info(`   💰 Trade Amount: ${config.TRADE_AMOUNT_SOL} SOL`);
  logger.info(`   📊 Max Slippage: ${config.MAX_SLIPPAGE_BPS} BPS`);
  logger.info(`   ⚡ Rate Limit: ${config.RATE_LIMIT_MAX_RPS} RPS`);
  logger.info(`   🎯 Raydium target mint: ${TARGET_TOKEN_MINT.toBase58()}`);
  logger.info(`   🎯 FOMO suffix: '${config.FOMO_MINT_SUFFIX || '(any)'}' | allowlist: ${getFomoMintAllowlist().length} mints | graduatedOnly: ${config.FOMO_TRADE_GRADUATED_ONLY} | onlyVerified: ${config.FOMO_ONLY_VERIFIED}`);
  if (getFomoMintAllowlist().length > 0) {
    logger.info({ allowlist: getFomoMintAllowlist() }, '   🎯 FOMO allowlist (only these pump mints trigger Radar)');
  }
  logger.info('═══════════════════════════════════════════');
}

// ═══════════════════════════════════════════════
// Graceful Shutdown Handler
// ═══════════════════════════════════════════════

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return; // Prevent double shutdown
  isShuttingDown = true;

  logger.info({ signal }, '🔴 Shutdown signal received — initiating graceful shutdown');

  try {
    // Order matters: stop ingestion first, then drain workers, then close DB
    logger.info('Stopping Radar listener...');
    await stopRadarListener();

    logger.info('Closing PredatorWorker (draining active jobs)...');
    await closePredatorWorker();

    logger.info('Closing execution queue...');
    await closeExecutionQueue();

    logger.info('Disconnecting MongoDB...');
    await disconnectMongo();

    logger.info('Disconnecting Redis...');
    await disconnectRedis();

    logger.info('✔ All subsystems shut down cleanly');
    process.exit(0);
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      'Error during shutdown'
    );
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Global unhandled error catchers
process.on('uncaughtException', (error) => {
  logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.fatal({ reason: message }, 'Unhandled promise rejection');
  gracefulShutdown('unhandledRejection');
});

// ═══════════════════════════════════════════════
// Entry Point
// ═══════════════════════════════════════════════

bootstrap().catch((error) => {
  logger.fatal(
    { error: error instanceof Error ? error.message : 'Unknown error' },
    'Fatal error during bootstrap'
  );
  process.exit(1);
});
