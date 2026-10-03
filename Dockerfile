FROM node:18-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg curl wget \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first
COPY package.json ./

# Install npm deps
RUN npm install --omit=dev

# Remove the old yt-dlp binary that yt-dlp-exec bundled
RUN rm -rf /app/node_modules/yt-dlp-exec/bin

# Download latest yt-dlp binary to system location
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Create symlink so yt-dlp-exec uses the latest binary
RUN mkdir -p /app/node_modules/yt-dlp-exec/bin \
    && ln -sf /usr/local/bin/yt-dlp /app/node_modules/yt-dlp-exec/bin/yt-dlp

# Verify
RUN yt-dlp --version && ls -la /app/node_modules/yt-dlp-exec/bin/

# Copy rest of the app
COPY . .

EXPOSE 3000
CMD ["npm", "start"]
