# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app

# Next.js inlines rewrites() into the build output, so the backend URL must be
# known at build time. Defaults to the docker-compose service name.
ARG BACKEND_URL=http://backend:4000
ENV BACKEND_URL=$BACKEND_URL

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app ./

EXPOSE 3000

# next.config.js rewrites read BACKEND_URL at server start
CMD ["npm", "start"]
