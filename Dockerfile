FROM node:20-slim

# Install system dependencies (ffmpeg, python for yt-dlp, opus)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && pip3 install yt-dlp --break-system-packages \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s \
  CMD node -e "console.log('OK')" || exit 1

CMD ["node", "index.js"]
