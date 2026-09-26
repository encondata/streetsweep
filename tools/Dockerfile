# Debian rather than Alpine for osmium-tool, which reads OpenStreetMap map files for the
# monthly street import (streets-import.js); Alpine does not package it.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Every .js in server/, so a new module cannot be left out of the image again.
COPY server/*.js ./
COPY public/ ./public/
COPY area-builder.html ./public/index.html
COPY login.html ./public/login.html

ENV PORT=80
EXPOSE 80
CMD ["node", "server.js"]
