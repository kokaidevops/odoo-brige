FROM node:20-alpine

# Install curl for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

# Copy package files first (layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

# Create logs directory
RUN mkdir -p logs

# Run migrations then start server
CMD ["sh", "-c", "node src/config/migrate.js && node src/server.js"]

EXPOSE 3000
