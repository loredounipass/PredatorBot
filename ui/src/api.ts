export interface Pool {
  dexId: string;
  pairAddress: string;
  quoteSymbol: string;
  liquidityUsd: number;
  venue: string;
  executable: boolean;
  executableReason: string;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchTokenName(mint: string): Promise<string> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const data = (await res.json()) as {
      pairs?: Array<{ baseToken?: { symbol?: string; name?: string } }>;
    };
    const bt = data.pairs?.[0]?.baseToken;
    if (bt?.symbol) return `${bt.symbol} — ${bt.name ?? ''}`.trim();
  } catch {
    // ignore → fallback address
  }
  return mint;
}
