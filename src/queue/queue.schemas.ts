import { z } from 'zod';

// ═══════════════════════════════════════════════
// Trade Payload Validation Schema
// ═══════════════════════════════════════════════

/**
 * Zod schema for runtime validation of TradePayload before enqueuing.
 * Ensures no malformed data enters the BullMQ pipeline.
 */
export const tradePayloadSchema = z.object({
  tokenMint: z
    .string()
    .min(32, 'tokenMint must be a valid base58 public key')
    .max(44, 'tokenMint exceeds maximum base58 length'),

  poolId: z
    .string()
    .min(32, 'poolId must be a valid base58 public key')
    .max(44, 'poolId exceeds maximum base58 length'),

  amountSol: z
    .number()
    .positive('amountSol must be positive')
    .max(100, 'amountSol exceeds safety cap of 100 SOL'),

  direction: z.enum(['BUY', 'SELL']),

  detectedAt: z
    .number()
    .int()
    .positive('detectedAt must be a valid Unix timestamp'),
});

// ═══════════════════════════════════════════════
// Validation Helper
// ═══════════════════════════════════════════════

export type ValidatedTradePayload = z.infer<typeof tradePayloadSchema>;

/**
 * Validates a trade payload against the schema.
 * Returns a discriminated result — no exceptions thrown.
 *
 * @param payload - Raw data to validate
 * @returns Zod SafeParseResult with typed data or error details
 */
export function validateTradePayload(
  payload: unknown
): z.SafeParseReturnType<unknown, ValidatedTradePayload> {
  return tradePayloadSchema.safeParse(payload);
}
