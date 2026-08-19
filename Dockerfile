FROM node:20-alpine

WORKDIR /app

# evita reinstall desnecessário
COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

RUN apk add --no-cache gcc musl-dev make \
  && make -C vendor/cryptonight \
  && cp vendor/cryptonight/cn-slow-hash /usr/local/bin/cn-slow-hash \
  && apk del gcc musl-dev make \
  && chmod 755 /app/docker-entrypoint.sh

EXPOSE 3710

# healthcheck leve
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3710/health || exit 1

# Run as root. Umbrel bind-mounts are often created as root:root 755,
# so a non-root USER cannot write wallets.json.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]