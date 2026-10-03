const express = require('express');
const cors = require('cors');
const ytDlp = require('yt-dlp-exec');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ==================== COOKIES LOAD ====================
let cookiesFile = null;
if (process.env.YT_COOKIES_BASE64) {
  try {
    cookiesFile = path.join('/tmp', 'yt-cookies.txt');
    fs.writeFileSync(cookiesFile,
      Buffer.from(process.env.YT_COOKIES_BASE64, 'base64').toString('utf-8'));
    console.log('[init] YouTube cookies loaded, size:', fs.statSync(cookiesFile).size);
  } catch (e) {
    console.error('[init] cookies failed:', e.message);
  }
} else {
  console.log('[init] YT_COOKIES_BASE64 not set');
}

// ==================== YOUTUBE SEARCH ====================
async function youtubeSearch(query, limit = 20) {
  try {
    const result = await ytDlp(`ytsearch${limit}:${query}`, {
      dumpSingleJson: true,
      flatPlaylist: true,
      noWarnings: true,
      cookies: cookiesFile,
      skipDownload: true
    });
    const entries = result.entries || [result];
    return entries.map(e => ({
      source: 'youtube',
      id: e.id,
      title: e.title || 'Unknown',
      artist: e.uploader || e.channel || 'YouTube',
      artwork: e.thumbnails?.[e.thumbnails.length - 1]?.url,
      durationMs: (e.duration || 0) * 1000,
      streamUrl: null,
      youtubeUrl: `https://www.youtube.com/watch?v=${e.id}`
    })).filter(t => t.id);
  } catch (e) {
    console.error('[yt search]', e.message);
    return [];
  }
}

// ==================== YOUTUBE STREAM URL ====================
async function youtubeStreamUrl(videoId) {
  // Try multiple clients — ANDROID_VR, WEB, IOS
  const clients = ['android_vr', 'web', 'ios'];

  for (const client of clients) {
    try {
      const info = await ytDlp(`https://www.youtube.com/watch?v=${videoId}`, {
        dumpSingleJson: true,
        format: 'bestaudio/best',
        noWarnings: true,
        cookies: cookiesFile,
        skipDownload: true,
        extractorArgs: `youtube:player_client=${client}`
      });

      // direct url
      if (info.url) {
        console.log(`[yt stream] ${client} OK`);
        return info.url;
      }

      // pick best audio format
      if (info.formats && info.formats.length) {
        const audio = info.formats
          .filter(f => f.acodec && f.acodec !== 'none' && f.url)
          .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
        if (audio && audio.url) {
          console.log(`[yt stream] ${client} OK (format pick)`);
          return audio.url;
        }
      }

      // fallback: any format with url
      if (info.formats) {
        const any = info.formats.find(f => f.url);
        if (any) {
          console.log(`[yt stream] ${client} OK (any format)`);
          return any.url;
        }
      }

      console.log(`[yt stream] ${client} — no url in response`);
    } catch (e) {
      console.error(`[yt stream] ${client} failed:`, e.message);
    }
  }

  console.error('[yt stream] all clients failed for', videoId);
  return null;
}

// ==================== JIOSAAVN ====================
function pickBestJio(s) {
  const dl = s.downloadUrl || [];
  const best = dl.find(d => (d.quality || '').includes('320')) || dl[dl.length - 1];
  return {
    source: 'jiosaavn',
    id: s.id,
    title: s.name,
    artist: s.primaryArtists || 'Unknown',
    album: s.album?.name || '',
    artwork: s.image?.[s.image.length - 1]?.link,
    durationMs: (parseInt(s.duration) || 0) * 1000,
    streamUrl: best?.link || best?.url,
    quality: best?.quality || '128kbps'
  };
}

const JIO_ENDPOINTS = [
  'https://jiosaavn-api-sumitkolhe.vercel.app',
  'https://jiosaavn-api.vercel.app',
  'https://saavn.dev/api'
];

async function jiosaavnSearch(query, limit = 30) {
  for (const base of JIO_ENDPOINTS) {
    try {
      const r = await axios.get(`${base}/search/songs`,
        { params: { query, limit }, timeout: 8000 });
      const songs = r.data?.data?.results || r.data?.results || [];
      const mapped = songs.map(pickBestJio).filter(t => t.streamUrl);
      if (mapped.length) return mapped;
    } catch (e) { continue; }
  }
  return [];
}

// ==================== CACHE ====================
const cache = new Map();
const TTL = 3600 * 1000;
const cGet = k => {
  const v = cache.get(k);
  if (!v || Date.now() > v.e) { cache.delete(k); return null; }
  return v.v;
};
const cSet = (k, v) => cache.set(k, { v, e: Date.now() + TTL });

// ==================== ROUTES ====================

app.get('/health', (_, res) => res.json({
  ok: true,
  cookies: !!cookiesFile,
  ts: Date.now()
}));

// DEBUG — cookies format check
app.get('/debug-cookies', (req, res) => {
  if (!cookiesFile) {
    return res.json({ error: 'cookies file not set' });
  }
  try {
    const content = fs.readFileSync(cookiesFile, 'utf-8');
    const lines = content.split('\n').slice(0, 5);
    const isNetscape = content.includes('# Netscape HTTP Cookie File')
                       || content.trim().startsWith('.youtube.com')
                       || content.trim().startsWith('#HttpOnly_');
    const isJSON = content.trim().startsWith('[')
                   || content.trim().startsWith('{');
    res.json({
      firstLines: lines,
      isNetscape,
      isJSON,
      totalLength: content.length,
      verdict: isJSON ? 'WRONG — JSON format'
             : isNetscape ? 'OK — Netscape format'
             : 'UNCLEAR — check firstLines'
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// SEARCH
app.get('/search', async (req, res) => {
  const q = req.query.q;
  const source = req.query.source || 'all';
  if (!q) return res.status(400).json({ error: 'missing q' });

  const key = `search:${source}:${q}`;
  const hit = cGet(key);
  if (hit) return res.json({ ...hit, cached: true });

  try {
    let results = [];
    if (source === 'youtube' || source === 'all') {
      const yt = await youtubeSearch(q, 20);
      results = results.concat(yt);
    }
    if (source === 'jiosaavn' || source === 'all') {
      const js = await jiosaavnSearch(q, 15);
      results = results.concat(js);
    }
    const out = { query: q, source, results };
    cSet(key, out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// STREAM
app.get('/stream', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'missing id' });

  const key = 'stream:' + id;
  const hit = cGet(key);
  if (hit) return res.json({ ...hit, cached: true });

  try {
    const url = await youtubeStreamUrl(id);
    if (!url) return res.status(404).json({ error: 'no stream found' });
    const out = { id, streamUrl: url };
    cSet(key, out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[jaymusic] :${PORT}`));
