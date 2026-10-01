FROM node:24.21.0-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data
EXPOSE 8080

USER node
CMD ["npm", "start"]

