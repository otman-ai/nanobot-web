# Stage 1: Build frontend
FROM node:20-alpine AS frontend-builder
RUN apk add --no-cache git
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Build WhatsApp bridge
FROM node:20-alpine AS bridge-builder
RUN apk add --no-cache git
WORKDIR /app/bridge
COPY bridge/package*.json ./
RUN npm install
COPY bridge/ ./
RUN npm run build

# Stage 3: Final image
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

# Copy Node.js binary from the node image (no apt needed)
COPY --from=node:20-alpine /usr/local/bin/node /usr/local/bin/node
COPY --from=node:20-alpine /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

WORKDIR /app

# Install Python dependencies first (cached layer)
COPY pyproject.toml README.md LICENSE ./
RUN mkdir -p nanobot_web bridge && touch nanobot_web/__init__.py && \
    uv pip install --system --no-cache . && \
    rm -rf nanobot_web bridge

# Copy the full source and install with all extras
COPY nanobot_web/ nanobot_web/
COPY bridge/ bridge/
RUN uv pip install --system --no-cache ".[web]" && \
    uv pip install --system --no-cache composio-core

# Copy pre-built WhatsApp bridge
COPY --from=bridge-builder /app/bridge/dist bridge/dist
COPY --from=bridge-builder /app/bridge/node_modules bridge/node_modules

# Copy pre-built frontend into the Python package
RUN mkdir -p nanobot_web/frontend
COPY --from=frontend-builder /app/frontend/dist nanobot_web/frontend/dist

# Create config directory
RUN mkdir -p /root/.nanobot-web

# Gateway default port
EXPOSE 18790

ENTRYPOINT ["nanobot-web"]
CMD ["status"]
