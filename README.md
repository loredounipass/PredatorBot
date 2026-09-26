# 🐺 PredatorBot

High-frequency Solana memecoin trading bot targeting Raydium AMM V4 pools.

## Architecture

```
Event-Driven Pipeline: Ingestion → Regulation → Execution → Persistence
```

| Layer | Module | Description |
|---|---|---|
| 1 | **Radar** | WebSocket listener on Raydium V4 logs via Alchemy WSS |
| 2 | **Queue** | BullMQ + Redis rate-limited job queue (20 RPS) |
| 3 | **Worker** | Pool fetch → slippage sim → tx build → sign → dispatch |
| 4 | **Database** | MongoDB ledger with indexed trade records |

## Quick Start

```bash
# 1. Start Redis & MongoDB via Docker
docker-compose up -d

# 2. Install dependencies
pnpm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your Alchemy API key, wallet private key, etc.

# 4. Run in development mode
pnpm dev

# 5. Run in production
pnpm build
pnpm start:prod

# Stop infrastructure
docker-compose down

# Stop & wipe all data
docker-compose down -v
```

## Project Structure

```
src/
├── main.ts              # Entry point — bootstrap orchestrator
├── config/              # Environment, constants, Redis factory
├── types/               # TypeScript interfaces & enums
├── radar/               # WebSocket ingestion & filtering
├── queue/               # BullMQ queue management
├── worker/              # Swap execution engine
├── database/            # MongoDB persistence layer
├── wallet/              # Keypair loading & ATA management
└── utils/               # Logger, retry strategy, SOL helpers
```

## Requirements

- Node.js v20+ LTS
- Redis (local or remote)
- MongoDB (local or remote)
- Alchemy Solana RPC (mainnet)

## License

Private — All rights reserved.
