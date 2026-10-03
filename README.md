# JAY MUSIC Backend (yt-dlp)

Node.js + yt-dlp service with YouTube cookies, to bypass bot detection.

## Deploy on Render (Docker)
1. Push this folder to GitHub.
2. Render -> New -> Web Service -> Docker.
3. Env vars:
   - YT_COOKIES_BASE64  (base64 of your cookies.txt — see below)
   - PORT=3000
4. Deploy, copy the URL, paste it into the app's Settings -> Backend URL.

## Getting cookies (for YT_COOKIES_BASE64)
1. In Chrome, log in to youtube.com.
2. Install the "Get cookies.txt LOCALLY" extension.
3. Open youtube.com, export cookies.txt.
4. Base64 it:
   - Mac/Linux: base64 -i cookies.txt -o cookies.b64
   - Windows:   certutil -encode cookies.txt cookies.b64
5. Paste the contents as YT_COOKIES_BASE64.

## Endpoints
- GET /health
- GET /search?q=kesariya
- GET /stream?id=VIDEO_ID
