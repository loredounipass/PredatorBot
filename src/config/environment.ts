import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// ═══════════════════════════════════════════════
// Zod Schema: Runtime Validation for .env
// ═══════════════════════════════════════════════
const environmentSchema = z.object({
  // Alchemy RPC
  ALCHEMY_RPC_HTTP_URL: z.string().url('ALCHEMY_RPC_HTTP_URL must be a valid URL'),
  ALCHEMY_RPC_WSS_URL: z.string().startsWith('wss://', 'ALCHEMY_RPC_WSS_URL must start with wss://'),

  // Wallet
  PREDATOR_WALLET_PRIVATE_KEY: z.string().min(32, 'PREDATOR_WALLET_PRIVATE_KEY is required'),

  // Redis
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),

  // MongoDB
  MONGO_URI: z.string().startsWith('mongodb', 'MONGO_URI must be a valid MongoDB connection string'),
  MONGO_DB_NAME: z.string().default('PredatorBot_Ledger'),

  // Bot operational parameters
  TRADE_AMOUNT_SOL: z.coerce.number().positive().default(1.25),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(10000).default(300),
  RATE_LIMIT_MAX_RPS: z.coerce.number().int().positive().default(20),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  JOB_MAX_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),
  JOB_RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(500),
  PRIORITY_FEE_MICROLAMPORTS: z.coerce.number().int().nonnegative().default(50000),

  // FOMO family criteria — which pump tokens the Radar accepts.
  // A mint matches when ALL non-empty criteria match:
  //   suffix    → mint ends with FOMO_MINT_SUFFIX (pump family; empty = any)
  //   allowlist → mint is in FOMO_MINT_ALLOWLIST (empty = any)
  //   creator   → token creator is in FOMO_CREATOR_ALLOWLIST (empty = any)
  FOMO_MINT_SUFFIX: z.string().default('pump'),
  FOMO_MINT_ALLOWLIST: z.string().default(''),
  FOMO_CREATOR_ALLOWLIST: z.string().default(''),

  // Graduation / verification gates (enforced in the worker, post-snapshot):
  //   FOMO_TRADE_GRADUATED_ONLY → only trade graduated tokens (bonding curve
  //     complete / PumpSwap pools). Requires PumpSwap decode support.
  //   FOMO_ONLY_VERIFIED        → only trade mints in FOMO_MINT_ALLOWLIST.
  //     There is no on-chain "verified" flag — the allowlist IS the
  //     operator-curated verified set.
  // NOTE: boolean env vars arrive as strings — "false" must parse to false,
  // so plain z.coerce.boolean() (Boolean("false") === true) is wrong here.
  FOMO_TRADE_GRADUATED_ONLY: z.string().default('false').transform(
    (v) => v.trim().toLowerCase() === 'true' || v.trim() === '1'
  ),
  FOMO_ONLY_VERIFIED: z.string().default('false').transform(
    (v) => v.trim().toLowerCase() === 'true' || v.trim() === '1'
  ),
});

// ═══════════════════════════════════════════════
// Parse & Export Typed Config
// ═══════════════════════════════════════════════
export type EnvironmentConfig = z.infer<typeof environmentSchema>;

let cachedConfig: EnvironmentConfig | null = null;

/**
 * Loads and validates all environment variables.
 * Throws a descriptive ZodError if any required variable is missing or invalid.
 * Returns a frozen, cached config object on subsequent calls.
 */
export function loadEnvironment(): EnvironmentConfig {
  if (cachedConfig) return cachedConfig;

  const parseResult = environmentSchema.safeParse(process.env);

  if (!parseResult.success) {
    const formattedErrors = parseResult.error.issues
      .map((issue) => `  ✗ ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `\n[FATAL] Environment validation failed:\n${formattedErrors}\n\n` +
      `Ensure all required variables are set in your .env file.\n` +
      `See .env.example for reference.\n`
    );
  }

  cachedConfig = Object.freeze(parseResult.data);
  return cachedConfig;
}

/**
 * Parses a comma-separated env list into trimmed, non-empty entries.
 */
export function parseCsvList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Operator-curated verified set: empty array = no restriction. */
export function getFomoMintAllowlist(): string[] {
  return parseCsvList(loadEnvironment().FOMO_MINT_ALLOWLIST);
}

/** Trusted token creators: empty array = any creator accepted. */
export function getFomoCreatorAllowlist(): string[] {
  return parseCsvList(loadEnvironment().FOMO_CREATOR_ALLOWLIST);
}
