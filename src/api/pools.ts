import type { VenueType } from '../types/trade.types';

/** Raw pair as returned by the Dexscreener tokens API. */
export interface DexPair {
  dexId: string;
  pairAddress: string;
  quoteToken?: { symbol?: string };
  liquidity?: { usd?: number };
}

/** Pool listed by the UI, with execution info. */
export interface ListedPool {
  dexId: string;
  pairAddress: string;
  quoteSymbol: string;
  liquidityUsd: number;
  venue: VenueType;
  /** True only when the worker can execute it today (Raydium + pago en SOL). */
  executable: boolean;
  executableReason: string;
}

const QUOTE_EXECUTABLE = new Set(['SOL', 'WSOL']);
const QUOTE_ALLOWED = new Set(['SOL', 'WSOL', 'USDC']);

function toVenue(dexId: string): VenueType {
  return dexId === 'pumpfun' ? 'pumpfun' : dexId === 'pumpswap' ? 'pumpswap' : 'raydium';
}

/**
 * Pure pool filter/rank for the Buy/Sell setup (unit-tested, no network).
 *
 * Rules:
 *   1. Solo Raydium: único venue con instrucciones de swap reales.
 *   2. Solo cotizados en SOL o USDC: el worker paga/recibe SOL
 *      (las rutas con pago en USDC aún no están cableadas).
 *   3. Ejecutable = Raydium + cotizado en SOL. Los USDC-quote se listan
 *      como no ejecutables con la razón explícita.
 *   4. Orden: SOL primero, luego USDC, por liquidez desc.
 */
export function filterTradablePools(pairs: DexPair[]): ListedPool[] {
  return pairs
    .filter((p) => p.dexId === 'raydium')
    .map((p) => {
      const quote = (p.quoteToken?.symbol ?? '?').toUpperCase();
      return {
        dexId: p.dexId,
        pairAddress: p.pairAddress,
        quoteSymbol: p.quoteToken?.symbol ?? '?',
        liquidityUsd: p.liquidity?.usd ?? 0,
        venue: toVenue(p.dexId),
        executable: QUOTE_EXECUTABLE.has(quote),
        executableReason: QUOTE_EXECUTABLE.has(quote)
          ? 'Pagas/recibes SOL — soportado'
          : QUOTE_ALLOWED.has(quote)
            ? 'Cotizado en USDC: pago en USDC aún no soportado (solo SOL)'
            : `Cotizado en ${p.quoteToken?.symbol ?? '?'}: el worker solo opera contra SOL/USDC`,
      };
    })
    .filter((p) => QUOTE_ALLOWED.has(p.quoteSymbol.toUpperCase()))
    .sort((a, b) => {
      const rank = (p: ListedPool) => (p.executable ? 0 : 1);
      return rank(a) - rank(b) || b.liquidityUsd - a.liquidityUsd;
    })
    .slice(0, 8);
}
