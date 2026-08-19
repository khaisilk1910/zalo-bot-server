FROM node:22-alpine
RUN apk add --no-cache jq ffmpeg
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN chmod +x entrypoint.sh
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD wget -q -O - "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null || exit 1
ENTRYPOINT ["./entrypoint.sh"]
