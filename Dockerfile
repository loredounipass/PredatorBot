FROM node:20-alpine AS builder

WORKDIR /app

RUN corepack enable

COPY package.json ./
RUN pnpm install --no-frozen-lockfile --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN pnpm run build

# ── React UI build ──
COPY ui/package.json ./ui/package.json
COPY ui/vite.config.ts ./ui/vite.config.ts
COPY ui/tsconfig.json ./ui/tsconfig.json
COPY ui/index.html ./ui/index.html
COPY ui/src ./ui/src
RUN pnpm --dir ui install --no-frozen-lockfile --ignore-scripts && pnpm --dir ui build

FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

RUN corepack enable

COPY package.json ./
RUN pnpm install --prod --no-frozen-lockfile --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/ui-dist ./ui-dist

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "process.exit(0)"

CMD ["node", "dist/main.js"]
