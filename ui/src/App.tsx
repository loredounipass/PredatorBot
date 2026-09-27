import { useCallback, useEffect, useState } from 'react';
import { api, fetchTokenName, type Pool } from './api';
import './styles.css';

interface MintsResp {
  allowlist: string[];
}

interface HealthResp {
  ok: boolean;
  wallet: string;
  solBalance: number | null;
  queue: Record<string, number>;
}

interface Trade {
  jobId: string;
  tokenMint: string;
  poolId: string;
  venue: string;
  amountSol: number;
  direction: string;
  status: string;
  txSignature: string | null;
  failureReason: string | null;
  createdAt: string;
}

export default function App() {
  const [health, setHealth] = useState<HealthResp | null>(null);
  const [mints, setMints] = useState<MintsResp | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [mint, setMint] = useState('');
  const [pools, setPools] = useState<Pool[]>([]);
  const [pool, setPool] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [buyAmount, setBuyAmount] = useState('0.01');
  const [buyMax, setBuyMax] = useState(false);
  const [sellAmount, setSellAmount] = useState('0.01');
  const [sellAll, setSellAll] = useState(false);
  const [busy, setBusy] = useState<'BUY' | 'SELL' | null>(null);
  const [msg, setMsg] = useState('');
  const [trades, setTrades] = useState<Trade[]>([]);
  const [balance, setBalance] = useState<{ solBalance: number; tokenUiAmount: number } | null>(null);
  const [copiedWallet, setCopiedWallet] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [priceInfo, setPriceInfo] = useState<{ priceNative?: number; priceUsd?: number; baseSymbol?: string; quoteSymbol?: string } | null>(null);
  const [orderTypeBuy, setOrderTypeBuy] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [orderTypeSell, setOrderTypeSell] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [limitPriceBuy, setLimitPriceBuy] = useState('');
  const [limitPriceSell, setLimitPriceSell] = useState('');

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await api<HealthResp>('/api/health'));
    } catch {
      // backend aún arrancando
    }
  }, []);

  const loadTrades = useCallback(async () => {
    try {
      const data = await api<{ trades: Trade[] }>('/api/trades?limit=20');
      setTrades(data.trades);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadTrades();
    const t = setInterval(() => {
      loadHealth();
      loadTrades();
    }, 5000);
    return () => clearInterval(t);
  }, [loadHealth, loadTrades]);

  useEffect(() => {
    api<MintsResp>('/api/mints')
      .then(async (m) => {
        setMints(m);
        const first = m.allowlist[0];
        setMint(first || '');
        setPool('');
        const all = [...m.allowlist];
        const entries = await Promise.all(all.map(async (x) => [x, await fetchTokenName(x)] as const));
        setNames(Object.fromEntries(entries));
      })
      .catch((e) => setMsg(`No hay backend: ${e.message}`));
  }, []);

  useEffect(() => {
    if (!mint) {
      setPools([]);
      setPool('');
      setBalance(null);
      return;
    }
    setPools([]);
    setPool('');
    setBalance(null);
    api<{ pools: Pool[] }>(`/api/pools?mint=${mint}`)
      .then((d) => {
        setPools(d.pools);
        const first = d.pools.find((p) => p.executable) ?? d.pools[0];
        if (first) setPool(first.pairAddress);
      })
      .catch((e) => setMsg(`Pools: ${e.message}`));
    api<{ solBalance: number; tokenUiAmount: number }>('/api/balance?mint=' + mint)
      .then(setBalance)
      .catch(() => setBalance(null));
  }, [mint]);

  useEffect(() => {
    if (!mint || !pool) { setPriceInfo(null); return; }
    let cancelled = false;
    const es = new EventSource(`/api/price/stream?mint=${mint}&pool=${pool}`);
    es.onmessage = (e) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(e.data);
        if (data) {
          setPriceInfo({
            priceNative: data.priceNative,
            priceUsd: data.priceUsd,
            baseSymbol: data.baseSymbol,
            quoteSymbol: data.quoteSymbol,
          });
        } else {
          setPriceInfo(null);
        }
      } catch {
        setPriceInfo(null);
      }
    };
    es.onerror = () => {
      if (!cancelled) setPriceInfo(null);
    };
    return () => { cancelled = true; es.close(); };
  }, [mint, pool]);

  useEffect(() => {
    if (orderTypeBuy === 'LIMIT' && priceInfo?.priceNative && !limitPriceBuy) {
      setLimitPriceBuy(String(Number(priceInfo.priceNative)));
    }
  }, [orderTypeBuy, priceInfo?.priceNative, limitPriceBuy]);

  useEffect(() => {
    if (orderTypeSell === 'LIMIT' && priceInfo?.priceNative && !limitPriceSell) {
      setLimitPriceSell(String(Number(priceInfo.priceNative)));
    }
  }, [orderTypeSell, priceInfo?.priceNative, limitPriceSell]);

  const selectedPool = pools.find((p) => p.pairAddress === pool);
  const executable = pools.length === 0 ? true : (selectedPool?.executable ?? false);
  const visiblePools = showAll ? pools : pools.filter((p) => p.executable);
  const tokenLabel = names[mint]?.split(' — ')[0] || `${mint.slice(0, 6)}…`;

  const formatNumber = (value?: number, decimals = 4) => {
    if (value == null || isNaN(value)) return '—';
    return Number(value).toFixed(decimals).replace(/\.?0+$/, '');
  };

  async function submit(direction: 'BUY' | 'SELL') {
    setBusy(direction);
    setMsg('');
    try {
      const orderType = direction === 'BUY' ? orderTypeBuy : orderTypeSell;
      const limitPriceRaw = direction === 'BUY' ? limitPriceBuy : limitPriceSell;
      const limitPrice = orderType === 'LIMIT' ? Number(limitPriceRaw) : undefined;
      if (orderType === 'LIMIT' && (!limitPriceRaw || isNaN(limitPrice!))) {
        setMsg('Precio límite requerido para orden LIMIT');
        setBusy(null);
        return;
      }
      const body = await api<{ jobId: string }>(`/api/trade`, {
        method: 'POST',
        body: JSON.stringify({
          direction,
          tokenMint: mint,
          poolId: pool,
          venue: 'raydium',
          amountSol: direction === 'BUY' ? (buyMax ? 0.01 : Number(buyAmount)) : sellAll ? 0.01 : Number(sellAmount),
          sellAll: direction === 'SELL' && sellAll,
          buyMax: direction === 'BUY' && buyMax,
          orderType,
          limitPrice,
        }),
      });
      setMsg(`Job encolado: ${body.jobId}`);
      loadTrades();
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : 'trade falló'}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="wrap">
      <h1>🐺 PredatorBot</h1>
      <p className="muted">
        {health ? (
          <>Wallet {health.wallet.slice(0, 6)}…{health.wallet.slice(-4)} · SOL {health.solBalance ?? '?'} · cola waiting {health.queue.waiting ?? 0} / failed {health.queue.failed ?? 0}</>
        ) : (
          'Conectando al backend…'
        )}
      </p>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Balance de la wallet</h3>
        {balance ? (
          <p>
            SOL: <b>{balance.solBalance.toFixed(4)}</b> · {tokenLabel}: <b>{balance.tokenUiAmount.toLocaleString()}</b>
          </p>
        ) : mint ? (
          <p className="muted">Cargando balance…</p>
        ) : (
          <p className="muted">Selecciona un token para ver su balance</p>
        )}
        {health && (
          <div style={{ marginTop: 16, display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'center' }}>
            <div style={{ textAlign: 'center', minWidth: 180 }}>
              <div onClick={async () => { await navigator.clipboard.writeText(health.wallet); setToast('Dirección copiada desde QR'); setTimeout(() => setToast(null), 2500); }} style={{ background: '#fff', padding: 10, borderRadius: 12, border: '1px solid #232d42', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', display: 'inline-block', cursor: 'pointer' }} title="Click para copiar dirección">
                <img alt="QR wallet" src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=solana:${health.wallet}`} style={{ display: 'block', borderRadius: 4, width: '100%', maxWidth: 240, height: 'auto' }} />
              </div>
              <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>Escanea para enviar SOL · Click para copiar</p>
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
                <code style={{ fontSize: 11, fontFamily: 'monospace', background: '#0b0e14', border: '1px solid #2b3a55', padding: '4px 8px', borderRadius: 6, wordBreak: 'break-all' }}>
                  {health.wallet.slice(0,6)}…{health.wallet.slice(-4)}
                </code>
                <button onClick={async () => { await navigator.clipboard.writeText(health.wallet); setCopiedWallet(true); setToast('Wallet copiada al portapapeles'); setTimeout(() => setCopiedWallet(false), 2000); setTimeout(() => setToast(null), 2500); }} style={{ padding: '6px 10px', fontSize: 12, background: copiedWallet ? '#16a34a' : '#22c55e', color: '#04120a', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
                  {copiedWallet ? '¡Copiado!' : 'Copiar'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>1 · Token y pool (solo SOL/USDC)</h3>
        <div className="row">
          <div className="field">
            <label>Token</label>
            <select value={mint} onChange={(e) => setMint(e.target.value)}>
              {mints && (
                <>
                  {mints.allowlist.map((m) => (
                    <option key={m} value={m}>{names[m] || m}</option>
                  ))}
                </>
              )}
            </select>
            {priceInfo && (
              <small className="muted" style={{ display: 'block', marginTop: 4 }}>
                Precio actual: {formatNumber(priceInfo.priceNative, 6)} {priceInfo.quoteSymbol || 'SOL'} / {priceInfo.baseSymbol || tokenLabel}
                {priceInfo.priceUsd != null ? ` · $${formatNumber(priceInfo.priceUsd, 3)}` : ''}
              </small>
            )}
          </div>
          <div className="field">
            <label>Pool Raydium (cotizado SOL/USDC)</label>
            {pools.length > 0 ? (
              <select value={pool} onChange={(e) => setPool(e.target.value)}>
                {visiblePools.map((p) => (
                  <option key={p.pairAddress} value={p.pairAddress}>
                    [{p.quoteSymbol}] ${Math.round(p.liquidityUsd).toLocaleString()} → {p.pairAddress.slice(0, 8)}… {p.executable ? '✓ ejecuta' : '✗'}
                  </option>
                ))}
              </select>
            ) : (
              <input value={pool} onChange={(e) => setPool(e.target.value)} placeholder="Pool address" />
            )}
          </div>
        </div>
        {pools.length > 0 && pools.some((p) => !p.executable) && (
          <label className="check muted">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Mostrar pools USDC no ejecutables (pago en USDC aún no soportado)
          </label>
        )}
        {selectedPool && !selectedPool.executable && (
          <p className="error">{selectedPool.executableReason}</p>
        )}
      </div>

      <div className="grid">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>2 · Comprar — pagas SOL, recibes {tokenLabel}</h3>
          <p className="muted">Ruta: SOL (tu wallet) → pool Raydium → {tokenLabel} (tu ATA). Solo pools ✓.</p>
          {priceInfo && (
            <p className="muted" style={{ marginTop: 4 }}>
              Precio actual: 1 {priceInfo.baseSymbol || tokenLabel} = {formatNumber(priceInfo.priceNative, 6)} {priceInfo.quoteSymbol || 'SOL'} {priceInfo.priceUsd != null ? `· $${formatNumber(priceInfo.priceUsd, 3)}` : ''}
            </p>
          )}
          <div className="row">
            <div className="field">
              <label>Cantidad (SOL o MAX)</label>
              <input value={buyAmount} disabled={buyMax} onChange={(e) => setBuyAmount(e.target.value)} placeholder="0.01" />
            </div>
            <div className="field">
              <label>Tipo de orden</label>
              <select value={orderTypeBuy} onChange={(e) => setOrderTypeBuy(e.target.value as 'MARKET' | 'LIMIT')}>
                <option value="MARKET">Market</option>
                <option value="LIMIT">Limit</option>
              </select>
            </div>
          </div>
          {orderTypeBuy === 'LIMIT' && (
            <div className="row">
              <div className="field">
                <label>Precio límite ({priceInfo?.quoteSymbol || 'SOL'} por {priceInfo?.baseSymbol || tokenLabel})</label>
                <input value={limitPriceBuy} onChange={(e) => setLimitPriceBuy(e.target.value)} placeholder="Precio objetivo" />
              </div>
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={buyMax} onChange={(e) => setBuyMax(e.target.checked)} /> MAX — usar todo el SOL (reserva 0.01 para fees)
          </label>
          <div className="actions">
            <button disabled={busy !== null || !mint || !pool || !executable} onClick={() => submit('BUY')}>
              {busy === 'BUY' ? 'Encolando…' : buyMax ? `COMPRAR MAX SOL → ${tokenLabel}` : `COMPRAR ${buyAmount} SOL → ${tokenLabel}`}
            </button>
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>3 · Vender — entregas {tokenLabel}, recibes SOL</h3>
          <p className="muted">Al revés de la compra: {tokenLabel} (tu ATA) → pool Raydium → SOL (tu wallet).</p>
          {priceInfo && (
            <p className="muted" style={{ marginTop: 4 }}>
              Precio actual: 1 {priceInfo.baseSymbol || tokenLabel} = {formatNumber(priceInfo.priceNative, 6)} {priceInfo.quoteSymbol || 'SOL'} {priceInfo.priceUsd != null ? `· $${formatNumber(priceInfo.priceUsd, 3)}` : ''}
            </p>
          )}
          <div className="row">
            <div className="field">
              <label>Cantidad (SOL nocional o MAX)</label>
              <input value={sellAmount} disabled={sellAll} onChange={(e) => setSellAmount(e.target.value)} placeholder="0.01" />
            </div>
            <div className="field">
              <label>Tipo de orden</label>
              <select value={orderTypeSell} onChange={(e) => setOrderTypeSell(e.target.value as 'MARKET' | 'LIMIT')}>
                <option value="MARKET">Market</option>
                <option value="LIMIT">Limit</option>
              </select>
            </div>
          </div>
          {orderTypeSell === 'LIMIT' && (
            <div className="row">
              <div className="field">
                <label>Precio límite ({priceInfo?.quoteSymbol || 'SOL'} por {priceInfo?.baseSymbol || tokenLabel})</label>
                <input value={limitPriceSell} onChange={(e) => setLimitPriceSell(e.target.value)} placeholder="Precio objetivo" />
              </div>
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={sellAll} onChange={(e) => setSellAll(e.target.checked)} /> MAX — vender todo el balance
          </label>
          <div className="actions">
            <button className="sell" disabled={busy !== null || !mint || !pool || !executable} onClick={() => submit('SELL')}>
              {busy === 'SELL' ? 'Encolando…' : sellAll ? `VENDER MAX ${tokenLabel} → SOL` : `VENDER ${sellAmount} SOL en ${tokenLabel} → SOL`}
            </button>
          </div>
          {msg && <p className={msg.startsWith('Error') ? 'error' : 'muted'}>{msg}</p>}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Últimos trades</h3>
        <div className="trades-wrap">
          <table>
            <thead>
              <tr><th>Job</th><th>Dir</th><th>Mint</th><th>Venue</th><th>Estado</th><th>Firma / error</th></tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.jobId}>
                  <td className="muted">{t.jobId.slice(-8)}</td>
                  <td>{t.direction}</td>
                  <td className="muted">
                    <a href={`https://solscan.io/token/${t.tokenMint}`} target="_blank" rel="noopener noreferrer" style={{ color: '#8b98ad', textDecoration: 'none' }}>
                      {t.tokenMint.slice(0, 6)}…
                    </a>
                  </td>
                  <td>{t.venue}</td>
                  <td><span className={`pill ${t.status === 'COMPLETED' ? 'ok' : t.status === 'FAILED' ? 'bad' : 'warn'}`}>{t.status}</span></td>
                  <td className="muted">
                    {t.txSignature ? (
                      <a href={`https://solscan.io/tx/${t.txSignature}`} target="_blank" rel="noopener noreferrer" style={{ color: '#e6edf3', textDecoration: 'underline' }}>
                        {t.txSignature.slice(0, 8)}…
                      </a>
                    ) : t.failureReason ? (
                      <span style={{ color: '#fca5a5' }}>{t.failureReason}</span>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, background: '#16a34a', color: '#04120a', padding: '10px 14px', borderRadius: 8, fontWeight: 600, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', zIndex: 1000 }}>
          {toast}
        </div>
      )}
    </div>
  );
}
