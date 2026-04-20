# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:20-alpine AS builder

# Enable pnpm via corepack (bundled with Node 20)
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
COPY public/ public/
RUN pnpm build

# Prune to production dependencies only
RUN pnpm deploy --frozen-lockfile --prod /app/prod

# ── Stage 2: Runtime ───────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Copy production artifacts
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/public/ public/
COPY --from=builder /app/prod/node_modules/ node_modules/
COPY --from=builder /app/package.json package.json

# Create data directory for runtime state (should be mounted as volume)
RUN mkdir -p /app/data && chown node:node /app/data

# Run as non-root user (node user exists in node:*-alpine images)
USER node

EXPOSE 1455

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
