# MCP server for the proxy-shopping network (stdio). Build from the repository root:
#   docker build -f packages/mcp/Dockerfile -t ghcr.io/pad01g/proxy-shopping-mcp:0.1.2 .
# Run (the key and the orders live in the volume mounted at /data):
#   docker run -i --rm -v proxy-shopping-mcp:/data ghcr.io/pad01g/proxy-shopping-mcp:0.1.2
FROM node:22-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY apps/web/package.json apps/web/
COPY apps/demo/package.json apps/demo/
RUN npm ci --no-audit --no-fund
COPY packages/core packages/core
COPY packages/mcp packages/mcp
RUN npm run build -w @proxy-shopping/core && npm run build -w @proxy-shopping/mcp
# Production dependencies of core and the MCP server only, staged in /out.
RUN rm -rf node_modules packages/*/node_modules \
 && npm ci --omit=dev --no-audit --no-fund -w @proxy-shopping/core -w @proxy-shopping/mcp \
 && mkdir -p /out/packages/core /out/packages/mcp \
 && cp -a package.json node_modules /out/ \
 && cp -a packages/core/package.json packages/core/dist /out/packages/core/ \
 && cp -a packages/mcp/package.json packages/mcp/dist /out/packages/mcp/ \
 && (test ! -d packages/core/node_modules || cp -a packages/core/node_modules /out/packages/core/) \
 && (test ! -d packages/mcp/node_modules || cp -a packages/mcp/node_modules /out/packages/mcp/) \
 && find /out/packages -name '*.map' -delete

FROM node:22-slim
LABEL io.modelcontextprotocol.server.name="io.github.pad01g/proxy-shopping"
LABEL org.opencontainers.image.source="https://github.com/pad01g/proxy-shopping-web"
LABEL org.opencontainers.image.description="MCP server for proxy-shopping: buy from cash-only or unsupported shops with crypto through a proxy shopper, with a 2-of-3 escrow; or earn as a proxy shopper"
LABEL org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production PS_DATA_DIR=/data
WORKDIR /app
COPY --from=build /out/ ./
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
ENTRYPOINT ["node", "/app/packages/mcp/dist/server.js"]
