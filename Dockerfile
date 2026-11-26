FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-pip git gosu ca-certificates fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --registry=https://registry.npmjs.org
COPY . .
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build
RUN npm run prepare:images
RUN npm run prepare:preview
RUN mkdir -p .runtime .data && chown -R node:node /app
ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]
EXPOSE 8080
CMD ["npm", "start"]
