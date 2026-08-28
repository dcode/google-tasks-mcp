# Multi-tenant HTTP mode only (see "Multi-user hosting" in README.md).
# Not needed for local stdio use — that's `npx google-tasks-mcp` / `npm install`.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# Fixed container-internal port; tell Obot's "Port" field the same value.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
