FROM oven/bun:1 AS base
WORKDIR /app

# Copy shared types
COPY packages/shared/src ./packages/shared/src

# Copy API package files and install deps
COPY apps/api/package.json ./apps/api/package.json
WORKDIR /app/apps/api
RUN bun install --production

# Copy API source
COPY apps/api/src ./src

EXPOSE 3001
ENV PORT=3001

CMD ["bun", "run", "src/index.ts"]
