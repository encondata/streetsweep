FROM node:22-alpine

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
