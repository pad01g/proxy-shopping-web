# Build from the repository root:  docker build -f apps/web/Dockerfile -t proxy-shopping-web .
# Run:  docker run -p 8080:80 -v $PWD/config.json:/usr/share/nginx/html/config.json:ro proxy-shopping-web
FROM node:22-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages/core packages/core
COPY apps/web apps/web
RUN npm run build -w @proxy-shopping/core && npm run build -w @proxy-shopping/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
# The image ships the lab defaults; mount your own /usr/share/nginx/html/config.json at runtime.
EXPOSE 80
