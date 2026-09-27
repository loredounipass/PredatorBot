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

  // Execution venue. Defaults to raydium so payloads enqueued before
  // the multi-venue upgrade (no venue field) still validate.
  venue: z.enum(['raydium', 'pumpfun', 'pumpswap']).default('raydium'),

  amountSol: z
    .number()
    .positive('amountSol must be positive')
    .max(100, 'amountSol exceeds safety cap of 100 SOL'),

  direction: z.enum(['BUY', 'SELL']),

  // SELL-ALL mode (CLI MAX): vende todo el balance del ATA.
  sellAll: z.boolean().optional().default(false),

  // BUY-MAX mode (UI MAX en compras): gasta todo el SOL menos reserva de fees.
  buyMax: z.boolean().optional().default(false),

  // Order type for market/limit execution
  orderType: z.enum(['MARKET', 'LIMIT']).optional().default('MARKET'),

  // Limit price in quote token per base token, optional for LIMIT orders
  limitPrice: z.number().positive().optional(),

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
