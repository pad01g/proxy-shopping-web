# The demo page (static files). Build from the repository root:
#   docker build -f apps/demo/Dockerfile -t proxy-shopping-demo .
# The lab (proxy-shopping-go compose service `demo`) mounts its own nginx.conf with the reverse proxies to the
# relays, chains, faucet and shopper nodes, and /demo-config.json. The nginx.conf shipped here only serves the files.
FROM node:22-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/demo/package.json apps/demo/
RUN npm ci --no-audit --no-fund
COPY packages/core packages/core
COPY apps/demo apps/demo
RUN npm run build -w @proxy-shopping/core && npm run build -w @proxy-shopping/demo

FROM nginx:1.27-alpine
COPY apps/demo/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/demo/dist /usr/share/nginx/html
EXPOSE 80
