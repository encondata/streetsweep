FROM node:22-alpine

WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server/server.js ./
COPY public/ ./public/
COPY area-builder.html ./public/index.html

ENV PORT=80
EXPOSE 80
CMD ["node", "server.js"]
