# Use a specific Node.js version for better reproducibility
FROM node:23.3.0-slim AS builder

# Install pnpm globally and install necessary build tools
RUN npm install -g pnpm@9.4.0 turbo && \
   apt-get update && \
   apt-get install -y git python3 make g++ pkg-config vim \
   # Canvas dependencies
   libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev && \
   apt-get clean && \
   rm -rf /var/lib/apt/lists/*

# Set Python 3 as the default python
RUN ln -s /usr/bin/python3 /usr/bin/python

# Set Node and Turbo memory settings
ENV NODE_OPTIONS="--max-old-space-size=8192"
ENV TURBO_MEMORY_LIMIT="8192"
ENV TURBO_PARALLEL_EXECUTION="false"
ENV CHILD_CONCURRENCY=1
ENV npm_config_build_from_source=true
ENV ADBLOCK=1
ENV DISABLE_OPENCOLLECTIVE=1
ENV NODE_ENV=production

# Set the working directory
WORKDIR /app

# First create the directory structure for all packages
RUN mkdir -p \
  agent \
  packages/core \
  packages/adapter-postgres \
  packages/adapter-sqlite \
  packages/adapter-sqljs \
  packages/adapter-supabase \
  packages/client-auto \
  packages/client-direct \
  packages/client-discord \
  packages/client-farcaster \
  packages/client-github \
  packages/client-telegram \
  packages/client-twitter \
  packages/content_cache \
  packages/create-eliza-app \
  packages/debug_audio \
  packages/plugin-0g \
  packages/plugin-aptos \
  packages/plugin-bootstrap \
  packages/plugin-coinbase \
  packages/plugin-conflux \
  packages/plugin-evm \
  packages/plugin-flow \
  packages/plugin-goat \
  packages/plugin-icp \
  packages/plugin-image-generation \
  packages/plugin-node \
  packages/plugin-solana \
  packages/plugin-starknet \
  packages/plugin-tee \
  packages/plugin-trustdb \
  packages/plugin-video-generation \
  packages/plugin-web-search \
  packages/plugin-whatsapp \
  packages/client-lens \
  packages/client-truth-social \
  packages/client-slack \
  packages/client-reddit \
  packages/plugin-intiface \
  packages/plugin-story \
  packages/plugin-nft-generation \
  packages/plugin-ton \
  packages/plugin-sui \
  packages/plugin-multiversx \
  packages/plugin-near \
  packages/plugin-ton \
  packages/plugin-zksync-era

# Copy root package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
# Copy scripts directory first (needed for postinstall scripts)
COPY packages/plugin-node/scripts ./packages/plugin-node/scripts

# Copy package.json files for all packages
COPY packages/core/package.json ./packages/core/
COPY packages/adapter-postgres/package.json ./packages/adapter-postgres/
COPY packages/adapter-sqlite/package.json ./packages/adapter-sqlite/
COPY packages/adapter-sqljs/package.json ./packages/adapter-sqljs/
COPY packages/adapter-supabase/package.json ./packages/adapter-supabase/
COPY packages/client-auto/package.json ./packages/client-auto/
COPY packages/client-direct/package.json ./packages/client-direct/
COPY packages/client-discord/package.json ./packages/client-discord/
COPY packages/client-farcaster/package.json ./packages/client-farcaster/
COPY packages/client-github/package.json ./packages/client-github/
COPY packages/client-telegram/package.json ./packages/client-telegram/
COPY packages/client-twitter/package.json ./packages/client-twitter/
COPY packages/create-eliza-app/package.json ./packages/create-eliza-app/
COPY packages/plugin-0g/package.json ./packages/plugin-0g/
COPY packages/plugin-aptos/package.json ./packages/plugin-aptos/
COPY packages/plugin-bootstrap/package.json ./packages/plugin-bootstrap/
COPY packages/plugin-coinbase/package.json ./packages/plugin-coinbase/
COPY packages/plugin-coinbase/advanced-sdk-ts/package.json ./packages/plugin-coinbase/advanced-sdk-ts/
COPY packages/plugin-conflux/package.json ./packages/plugin-conflux/
COPY packages/plugin-evm/package.json ./packages/plugin-evm/
COPY packages/plugin-flow/package.json ./packages/plugin-flow/
COPY packages/plugin-goat/package.json ./packages/plugin-goat/
COPY packages/plugin-icp/package.json ./packages/plugin-icp/
COPY packages/plugin-image-generation/package.json ./packages/plugin-image-generation/
COPY packages/plugin-node/package.json ./packages/plugin-node/
COPY packages/plugin-solana/package.json ./packages/plugin-solana/
COPY packages/plugin-starknet/package.json ./packages/plugin-starknet/
COPY packages/plugin-tee/package.json ./packages/plugin-tee/
COPY packages/plugin-trustdb/package.json ./packages/plugin-trustdb/
COPY packages/plugin-video-generation/package.json ./packages/plugin-video-generation/
COPY packages/plugin-web-search/package.json ./packages/plugin-web-search/
COPY packages/plugin-whatsapp/package.json ./packages/plugin-whatsapp/
COPY packages/client-lens/package.json ./packages/client-lens/
COPY packages/client-truth-social/package.json ./packages/client-truth-social/
COPY packages/plugin-ton/package.json ./packages/plugin-ton/
COPY packages/plugin-sui/package.json ./packages/plugin-sui/
COPY packages/plugin-multiversx/package.json ./packages/plugin-multiversx/
COPY packages/plugin-near/package.json ./packages/plugin-near/
COPY packages/plugin-zksync-era/package.json ./packages/plugin-zksync-era/
COPY packages/client-slack/package.json ./packages/client-slack/
COPY packages/client-reddit/package.json ./packages/client-reddit/
COPY packages/plugin-intiface/package.json ./packages/plugin-intiface/
COPY packages/plugin-story/package.json ./packages/plugin-story/
COPY packages/plugin-nft-generation/package.json ./packages/plugin-nft-generation/

# Copy agent package.json
COPY agent/package.json ./agent/

# First installation to set up the base dependencies
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --unsafe-perm --no-scripts --shamefully-hoist --no-frozen-lockfile --force

# Copy docs with its contents
COPY docs ./docs/

# Install Docusaurus and its plugins in the docs directory
WORKDIR /app/docs
RUN pnpm add -D @docusaurus/core@latest @docusaurus/preset-classic@latest && \
    pnpm add -D docusaurus-plugin-typedoc@latest typedoc@latest && \
    pnpm install

# Return to app directory
WORKDIR /app

# Handle individual native modules
RUN cd /app/node_modules/bigint-buffer && npm rebuild || true && \
    cd /app/node_modules/@swc/core && npm rebuild || true && \
    cd /app/node_modules/bufferutil && npm rebuild || true && \
    cd /app/node_modules/utf-8-validate && npm rebuild || true && \
    cd /app/node_modules/canvas && npm rebuild || true && \
    cd /app/node_modules/secp256k1 && npm rebuild || true

# Final install to ensure everything is set up
RUN pnpm install -r --no-scripts

# Now copy the rest of the code
COPY . .

# Build the project without docs
RUN turbo run build --filter=!eliza-docs --filter=!@ai16z/plugin-sample && \
    pnpm prune --prod

# Create a new stage for the final image
FROM node:23.3.0-slim

# Install runtime dependencies if needed
RUN npm install -g pnpm@9.4.0 && \
  apt-get update && \
  apt-get install -y git python3 pkg-config vim \
  libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts and production dependencies from the builder stage
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/.npmrc ./
COPY --from=builder /app/turbo.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/agent ./agent
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/characters ./characters

# Set the command to run the application
CMD ["tail", "-f", "/dev/null"]