FROM node:18-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg curl wget \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && yt-dlp --version

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

RUN rm -f /app/node_modules/yt-dlp-exec/bin/yt-dlp \
    && ln -sf /usr/local/bin/yt-dlp /app/node_modules/yt-dlp-exec/bin/yt-dlp

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
