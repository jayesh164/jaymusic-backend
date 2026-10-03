const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const execFileAsync = promisify(execFile);

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
    console.log('[init] cookies loaded, size:', fs.statSync(cookiesFile).size);
  } catch (e) {
    console.error('[init] cookies failed:', e.message);
  }
}

// ==================== YT-DLP HELPER ====================
// Direct yt-dlp binary call (no npm wrapper)
async function runYtDlp(args) {
  const ytdlpBin = process.env.YTDLP_BIN || '/usr/local/bin/yt-dlp';
  try {
    const { stdout } = await execFileAsync(ytdlpBin, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 60000
    });
    return stdout;
  } catch (e) {
    console.error('[yt-dlp error]', e.message);
    if (e.stderr) console.error('[yt-dlp stderr]', e.stderr);
    throw e;
  }
}

// ==================== YOUTUBE SEARCH ====================
async function youtubeSearch(query, limit = 20) {
  try {
    const args = [
      `ytsearch${limit}:${query}`,
      '--dump-single-json',
      '--flat-playlist',
      '--no-warnings',
      '--skip-download'
    ];
    if (cookiesFile) args.push('--cookies', cookiesFile);

    const stdout = await runYtDlp(args);
    const result = JSON.parse(stdout);
    const entries = result.entries || [result];

    return entries.map(e => ({
      source: 'youtube',
      id: e.id,
      title: e.title || 'Unknown',
      artist: e.uploader || e.channel || 'YouTube',
      artwork: e.thumbnails?.[e.thumbnails.length - 1]?.url || e.thumbnail,
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
  const clients = ['android_vr', 'web', 'ios', 'tv_embedded'];

  for (const client of clients) {
    try {
      const args = [
        `https://www.youtube.com/watch?v=${videoId}`,
        '--dump-single-json',
        '--no-warnings',
        '--skip-download',
        '--extractor-args', `youtube:player_client=${client}`
      ];
      if (cookiesFile) args.push('--cookies', cookiesFile);

      const stdout = await runYtDlp(args);
      const info = JSON.parse(stdout);

      // If format not picked, pick from formats list
      if (info.url) {
        console.log(`[yt stream] ${client} OK direct`);
        return info.url;
      }

      if (info.formats && info.formats.length) {
        // prefer audio-only
        const audio = info.formats
          .filter(f => f.acodec && f.acodec !== 'none' && f.url)
          .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
        if (audio && audio.url) {
          console.log(`[yt stream] ${client} OK audio-only`);
          return audio.url;
        }
        // any
        const any = info.formats.find(f => f.url);
        if (any) {
          console.log(`[yt stream] ${client} OK any`);
          return any.url;
        }
      }

      console.log(`[yt stream] ${client} — no url`);
    } catch (e) {
      console.error(`[yt stream] ${client} failed`);
    }
  }
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
const cGet = k => { const v = cache.get(k); if (!v || Date.now() > v.e) { cache.delete(k); return null; } return v.v; };
const cSet = (k, v) => cache.set(k, { v, e: Date.now() + TTL });

// ==================== ROUTES ====================
app.get('/health', (_, res) => res.json({ ok: true, cookies: !!cookiesFile, ts: Date.now() }));

app.get('/debug-cookies', (req, res) => {
  if (!cookiesFile) return res.json({ error: 'not set' });
  try {
    const content = fs.readFileSync(cookiesFile, 'utf-8');
    res.json({
      firstLines: content.split('\n').slice(0, 5),
      isNetscape: content.includes('# Netscape HTTP Cookie File'),
      totalLength: content.length
    });
  } catch (e) { res.json({ error: e.message }); }
});

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
      results = results.concat(await youtubeSearch(q, 20));
    }
    if (source === 'jiosaavn' || source === 'all') {
      results = results.concat(await jiosaavnSearch(q, 15));
    }
    const out = { query: q, source, results };
    cSet(key, out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
