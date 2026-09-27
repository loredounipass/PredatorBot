import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { loadEnvironment, getFomoMintAllowlist } from '../config/environment';
import { SOLANA_COMMITMENT } from '../config/constants';
import { getExecutionQueue } from '../queue/queue.manager';
import { validateTradePayload } from '../queue/queue.schemas';
import { findRecentTrades } from '../database/trade.repository';
import { loadWalletKeypair } from '../wallet/wallet.loader';
import { filterTradablePools } from './pools';
import { createLogger } from '../utils/logger';

const logger = createLogger('ApiServer');

/**
 * Minimal HTTP API for the React UI (replaces the interactive CLI):
 *   GET  /api/health        → bot + queue + wallet status
 *   GET  /api/mints         → allowlist
 *   GET  /api/pools?mint=…  → Dexscreener pools, Raydium/SOL first
 *   POST /api/trade         → validate + enqueue BullMQ job
 *   GET  /api/trades        → recent Mongo ledger entries
 */
export function startApiServer(): void {
  const config = loadEnvironment();
  const app = express();
  const port = parseInt(process.env.PORT || '3000', 10);

  app.use(cors());
  app.use(express.json());

  app.get('/api/health', async (_req, res) => {
    try {
      const queue = getExecutionQueue();
      const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed');
      const wallet = loadWalletKeypair();
      let solBalance: number | null = null;
      try {
        const conn = new Connection(config.ALCHEMY_RPC_HTTP_URL, SOLANA_COMMITMENT);
        const lamports = await conn.getBalance(wallet.publicKey);
        solBalance = lamports / 1_000_000_000;
      } catch {
        solBalance = null;
      }
      res.json({
        ok: true,
        wallet: wallet.publicKey.toBase58(),
        solBalance,
        queue: counts,
        tradeAmountSol: config.TRADE_AMOUNT_SOL,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'health failed' });
    }
  });

  app.get('/api/balance', async (req, res) => {
    try {
      const mintStr = String(req.query.mint || '').trim();
      if (!mintStr) {
        res.status(400).json({ ok: false, error: 'mint query param required' });
        return;
      }
      const wallet = loadWalletKeypair();
      const conn = new Connection(config.ALCHEMY_RPC_HTTP_URL, SOLANA_COMMITMENT);
      const lamports = await conn.getBalance(wallet.publicKey);
      const solBalance = lamports / 1_000_000_000;

      let tokenUiAmount = 0;
      let tokenBalanceRaw = 0n;
      try {
        const mintPubkey = new PublicKey(mintStr);
        const accounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: mintPubkey }) as unknown as any[];
        const total = accounts.reduce((acc: bigint, a: any) => {
          const info = a.account.data.parsed.info;
          const amount = BigInt(info.tokenAmount.amount);
          return acc + amount;
        }, 0n);
        tokenBalanceRaw = total;
        const decimals = accounts[0]?.account.data.parsed.info.tokenAmount.decimals ?? 0;
        tokenUiAmount = Number(total) / Math.pow(10, decimals);
      } catch {
        // token not found or error
      }

      res.json({ ok: true, wallet: wallet.publicKey.toBase58(), solBalance, tokenMint: mintStr, tokenBalanceRaw: tokenBalanceRaw.toString(), tokenUiAmount });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'balance failed' });
    }
  });

  app.get('/api/mints', (_req, res) => {
    res.json({
      allowlist: getFomoMintAllowlist(),
      fomoSuffix: config.FOMO_MINT_SUFFIX,
    });
  });

  app.get('/api/pools', async (req, res) => {
    const mint = String(req.query.mint || '').trim();
    if (!mint) {
      res.status(400).json({ ok: false, error: 'mint query param required' });
      return;
    }
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      const data = (await r.json()) as {
        pairs?: Array<{
          dexId: string;
          pairAddress: string;
          quoteToken?: { symbol?: string };
          liquidity?: { usd?: number };
        }>;
      };
      // Solo Raydium cotizado en SOL/USDC (ver pools.ts) — resto no ejecutable hoy.
      res.json({ ok: true, mint, pools: filterTradablePools(data.pairs ?? []) });
    } catch (error) {
      res.status(502).json({ ok: false, error: error instanceof Error ? error.message : 'pools fetch failed' });
    }
  });

  app.post('/api/trade', async (req, res) => {
    const { direction, tokenMint, poolId, venue, amountSol, sellAll, buyMax, orderType, limitPrice } = req.body ?? {};
    const dir = direction === 'SELL' ? 'SELL' : 'BUY';
    const payload = {
      tokenMint: String(tokenMint || '').trim(),
      poolId: String(poolId || '').trim(),
      venue: venue || 'raydium',
      amountSol: sellAll || buyMax ? config.TRADE_AMOUNT_SOL : Number(amountSol),
      direction: dir,
      detectedAt: Date.now(),
      sellAll: sellAll === true,
      buyMax: buyMax === true,
      orderType: orderType === 'LIMIT' ? 'LIMIT' : 'MARKET',
      limitPrice: typeof limitPrice === 'number' && limitPrice > 0 ? limitPrice : undefined,
    };
    if (payload.sellAll && dir === 'BUY') {
      res.status(400).json({ ok: false, error: 'MAX de venta (sellAll) solo aplica a SELL' });
      return;
    }
    if (payload.buyMax && dir === 'SELL') {
      res.status(400).json({ ok: false, error: 'MAX de compra (buyMax) solo aplica a BUY' });
      return;
    }
    const validation = validateTradePayload(payload);
    if (!validation.success) {
      res.status(400).json({
        ok: false,
        error: validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
      });
      return;
    }
    try {
      const queue = getExecutionQueue();
      const job = await queue.add('PredatorSwapJob', validation.data, {
        jobId: `${Date.now()}-${payload.tokenMint.slice(0, 8)}`,
      });
      logger.info({ jobId: job.id, ...payload }, 'UI trade enqueued');
      res.json({ ok: true, jobId: job.id, ...payload });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'enqueue failed' });
    }
  });

  app.get('/api/price/stream', async (req, res) => {
    const mint = String(req.query.mint || '').trim();
    const pool = String(req.query.pool || '').trim();
    if (!mint) {
      res.status(400).send('mint required');
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');

    let effectivePool = pool;
    try {
      if (!effectivePool) {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
        const data = await r.json() as any;
        const pairs = data?.pairs || [];
        if (!pairs.length) {
          res.write(`data: ${JSON.stringify(null)}\n\n`);
          return;
        }
        const best = pairs.reduce((a: any, b: any) => {
          const la = Number(a.liquidity?.usd || 0);
          const lb = Number(b.liquidity?.usd || 0);
          return lb > la ? b : a;
        }, pairs[0]);
        effectivePool = best.pairAddress;
      }
    } catch {
      res.write(`data: ${JSON.stringify(null)}\n\n`);
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const sendPrice = async () => {
      try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${effectivePool}`);
        const data = await r.json() as any;
        const pair = data?.pairs?.[0];
        const payload = pair ? {
          priceNative: pair.priceNative,
          priceUsd: pair.priceUsd,
          baseSymbol: pair.baseToken?.symbol,
          quoteSymbol: pair.quoteToken?.symbol,
          poolAddress: effectivePool,
          updatedAt: Date.now(),
        } : null;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        res.write(`data: ${JSON.stringify(null)}\n\n`);
      }
    };
    await sendPrice();
    const interval = setInterval(sendPrice, 1000);
    req.on('close', () => clearInterval(interval));
  });

  app.get('/api/trades', async (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit || '30'), 10) || 30, 100);
      const trades = await findRecentTrades(limit);
      res.json({ ok: true, trades });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'trades failed' });
    }
  });

  // Serve built React UI (ui/dist) when present — single-container deploy.
  const uiDist = path.join(__dirname, '..', '..', 'ui-dist');
  if (fs.existsSync(path.join(uiDist, 'index.html'))) {
    app.use(express.static(uiDist));
    app.get('*', (_req, res) => res.sendFile(path.join(uiDist, 'index.html')));
    logger.info({ uiDist }, 'Serving React UI from ui-dist');
  }

  // Validate wallet pubkey at boot (fail fast on malformed key, not on RPC).
  try {
    const pk = loadWalletKeypair().publicKey;
    new PublicKey(pk.toBase58());
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : 'wallet check failed' }, 'Wallet check failed');
  }

  app.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'API+UI server listening');
  });
}
