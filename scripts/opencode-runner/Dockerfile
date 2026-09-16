FROM debian:bookworm-slim
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG OPENCODE_VERSION=1.18.31
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 nodejs npm && rm -rf /var/lib/apt/lists/* \
    && npm install -g opencode-ai@${OPENCODE_VERSION}
RUN npm install -g node@22.22.3
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . ./
ENV NODE_ENV=production OPENCODE_DISABLE_AUTOUPDATE=true OPENCODE_DISABLE_MODELS_FETCH=true
EXPOSE 4097
CMD ["node", "server.cjs"]
