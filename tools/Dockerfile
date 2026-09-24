FROM node:22-alpine

WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server/server.js server/identity.js server/photos.js \
     server/reset-password.js server/migrate-photos.js ./
COPY public/ ./public/
COPY area-builder.html ./public/index.html
COPY login.html ./public/login.html

ENV PORT=80
EXPOSE 80
CMD ["node", "server.js"]
