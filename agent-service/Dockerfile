# karos-agent-service — API + worker image (select role via command)
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY runner/src ./runner/src
COPY tools ./tools
COPY test ./test
RUN npx tsc -p tsconfig.json

FROM node:24-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY config ./config
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
