# ---- build stage ----
FROM node:22-slim AS build
WORKDIR /app

# OpenSSL is required by Prisma's query engine
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Compile the seed separately (ts-node is a devDependency, absent at runtime)
RUN npx tsc prisma/seed.ts --outDir seed-dist --module commonjs --target es2022 --esModuleInterop --skipLibCheck

# ---- runtime stage ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY prisma ./prisma
RUN npx prisma generate

COPY --from=build /app/dist ./dist
COPY --from=build /app/seed-dist/seed.js ./prisma/seed.js

EXPOSE 4000

# Apply migrations (and optionally seed) before starting the API.
# SEED_ON_START=true reseeds mock data — handy for demo environments.
CMD ["sh", "-c", "npx prisma migrate deploy && if [ \"$SEED_ON_START\" = \"true\" ]; then node prisma/seed.js || true; fi && node dist/index.js"]
