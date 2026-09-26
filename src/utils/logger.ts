import pino from 'pino';

/**
 * Creates a child logger scoped to a specific module.
 * Uses structured JSON logging in production, pretty-prints in dev.
 *
 * @param moduleName - Identifier for the module creating the logger (e.g., 'RadarListener')
 */
export function createLogger(moduleName: string): pino.Logger {
  const isProduction = process.env.NODE_ENV === 'production';

  const baseLogger = pino({
    name: 'PredatorBot',
    level: process.env.LOG_LEVEL || 'info',

    // Redact sensitive fields from log output
    redact: {
      paths: [
        'PREDATOR_WALLET_PRIVATE_KEY',
        'ALCHEMY_RPC_HTTP_URL',
        'ALCHEMY_RPC_WSS_URL',
        'REDIS_PASSWORD',
      ],
      censor: '[REDACTED]',
    },

    // Pretty-print transport for development only
    transport: isProduction
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
  });

  return baseLogger.child({ module: moduleName });
}
