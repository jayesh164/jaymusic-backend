FROM node:18-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg curl \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && pip3 install --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000
CMD ["npm", "start"]
