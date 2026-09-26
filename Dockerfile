FROM node:20-alpine AS builder

WORKDIR /app

RUN corepack enable

COPY package.json ./
RUN pnpm install --no-frozen-lockfile --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN pnpm run build

FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

RUN corepack enable

COPY package.json ./
RUN pnpm install --prod --no-frozen-lockfile --ignore-scripts

COPY --from=builder /app/dist ./dist

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "process.exit(0)"

CMD ["node", "dist/main.js"]
