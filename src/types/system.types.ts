// ═══════════════════════════════════════════════
// Bot Lifecycle Status
// ═══════════════════════════════════════════════

/** Global bot state visible in health checks and logs */
export type BotStatus =
  | 'INITIALIZING'
  | 'SCANNING'
  | 'EXECUTING'
  | 'IDLE'
  | 'SHUTTING_DOWN'
  | 'ERROR';

// ═══════════════════════════════════════════════
// Worker Performance Metrics
// ═══════════════════════════════════════════════

/** Real-time metrics emitted by the PredatorWorker */
export interface WorkerMetrics {
  readonly jobsProcessed: number;
  readonly jobsFailed: number;
  readonly avgExecutionMs: number;
  readonly lastHeartbeat: number; // Unix timestamp ms
}

// ═══════════════════════════════════════════════
// Error Classification Codes
// ═══════════════════════════════════════════════

/** Enumerated error codes for structured logging and retry decisions */
export enum PredatorErrorCode {
  RPC_CONNECTION_FAILED  = 'ERR_RPC_CONN',
  POOL_NOT_FOUND         = 'ERR_POOL_404',
  SLIPPAGE_EXCEEDED      = 'ERR_SLIPPAGE',
  INSUFFICIENT_BALANCE   = 'ERR_BALANCE',
  TX_SIMULATION_FAILED   = 'ERR_SIM_FAIL',
  TX_SEND_FAILED         = 'ERR_TX_SEND',
  ATA_CREATION_FAILED    = 'ERR_ATA',
  RATE_LIMIT_EXCEEDED    = 'ERR_RATE_429',
  MONGO_WRITE_FAILED     = 'ERR_MONGO_WR',
  REDIS_UNAVAILABLE      = 'ERR_REDIS',
  WALLET_LOAD_FAILED     = 'ERR_WALLET',
  ENV_VALIDATION_FAILED  = 'ERR_ENV',
}

// ═══════════════════════════════════════════════
// Typed Error Wrapper
// ═══════════════════════════════════════════════

/** Structured error with PredatorBot-specific classification */
export class PredatorError extends Error {
  public readonly code: PredatorErrorCode;
  public readonly context: Record<string, unknown>;

  constructor(
    code: PredatorErrorCode,
    message: string,
    context: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'PredatorError';
    this.code = code;
    this.context = context;
  }
}
