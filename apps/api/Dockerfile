FROM oven/bun:1 AS base

# Set up monorepo structure matching local dev
WORKDIR /repo

# Copy shared types (mirrors local packages/shared/src)
COPY packages/shared/src ./packages/shared/src

# Copy API and install deps
COPY apps/api/package.json ./apps/api/package.json
WORKDIR /repo/apps/api
RUN bun install --production

# Copy API source
COPY apps/api/src ./src

EXPOSE 3001
ENV PORT=3001

CMD ["bun", "run", "src/index.ts"]
