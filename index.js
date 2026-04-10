#!/usr/bin/env node
/**
 * HebSubScout — Stremio Addon
 * Hebrew subtitle intelligence: match % on every source, auto-select best subtitle.
 *
 * Works with Stremio AND Nuvio.
 * Free and open source alternative to "Heb Subs Premium".
 */

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const { enrichStreams, matchSource } = require('./lib/matcher');
const { searchAll, downloadKtuvit } = require('./lib/providers');
const { searchIndexers } = require('./lib/indexers');
const { checkInstantAvailability, resolveTorrent } = require('./lib/realdebrid');
const { detectQuality, detectInfo } = require('./lib/scrapers');
const cache = require('./lib/cache');
const http = require('http');
const fs = require('fs');
const path = require('path');

// =========================================================================
// MANIFEST
// =========================================================================

const manifest = {
  id: 'com.hebsubscout.stremio',
  version: '2.0.0',
  name: 'HebSubScout',
  description: 'Hebrew subtitle intelligence — match % on every source, auto-selects best subtitle. Built-in Real-Debrid. Free & open source.',
  logo: 'https://shahar015.github.io/hebsubscout/repo/plugin.video.hebscout/icon.png',
  background: 'https://shahar015.github.io/hebsubscout/repo/skin.hebscout/fanart.jpg',
  resources: ['stream', 'subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {
    configurable: true,
    configurationRequired: false,
  },
};

const builder = new addonBuilder(manifest);

// =========================================================================
// HELPERS
// =========================================================================

function parseId(id) {
  // Movies: "tt1234567"
  // Series: "tt1234567:2:5" (imdb:season:episode)
  const parts = id.split(':');
  return {
    imdbId: parts[0],
    season: parts[1] ? parseInt(parts[1]) : null,
    episode: parts[2] ? parseInt(parts[2]) : null,
  };
}

function getConfig(userConfig) {
  // Merge: user config (from URL path) overrides env vars
  return {
    rdToken: (userConfig && userConfig.rdToken) || process.env.RD_TOKEN || '',
    ktuvitEmail: (userConfig && userConfig.ktuvitEmail) || process.env.KTUVIT_EMAIL || '',
    ktuvitPassword: (userConfig && userConfig.ktuvitPassword) || process.env.KTUVIT_PASSWORD || '',
    opensubsApiKey: (userConfig && userConfig.opensubsApiKey) || process.env.OPENSUBS_API_KEY || '',
    mediafusionUrl: (userConfig && userConfig.mediafusionUrl) || process.env.MEDIAFUSION_URL || '',
  };
}

/**
 * Encode user config to URL-safe base64 for embedding in addon URL.
 */
function encodeConfig(config) {
  return Buffer.from(JSON.stringify(config)).toString('base64url');
}

/**
 * Decode user config from URL path prefix.
 */
function decodeConfig(encoded) {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString());
  } catch {
    return null;
  }
}

// Store per-request user config (set by URL path middleware)
let requestConfig = null;

/**
 * Quick check if buffer is valid UTF-8 (checks first 200 bytes for Hebrew range).
 */
function isValidUtf8(buf) {
  try {
    const str = buf.toString('utf-8');
    // If Hebrew chars appear correctly (Unicode range), it's UTF-8
    return /[\u0590-\u05FF]/.test(str.slice(0, 500));
  } catch { return false; }
}

function buildStreamTitle(source) {
  // Line 1: Quality + codec + Hebrew match %
  let line1 = source.quality || '';
  if (source.info && source.info.length > 0) {
    line1 += ' ' + source.info.slice(0, 3).join(' '); // Max 3 tags
  }
  if (source.matchPct > 0) {
    line1 += ` [עב ${source.matchPct}%]`;
  } else if (source.matchPct === 0 && source._subsChecked) {
    line1 += ' [עב ✗]';
  }

  // Line 2: Size + seeders
  const meta = [];
  if (source.size) meta.push(source.size);
  if (source.seeders > 0) meta.push(`👤 ${source.seeders}`);
  const line2 = meta.join(' ');

  return [line1.trim(), line2].filter(Boolean).join('\n');
}

// =========================================================================
// STREAM HANDLER
// =========================================================================

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[HebSubScout] Stream request: ${type} ${id}`);
  const { imdbId, season, episode } = parseId(id);
  const config = getConfig(requestConfig);
  const rdToken = config.rdToken || '';

  // Fetch torrents from indexers and Hebrew subtitles in parallel
  const [torrents, subtitles] = await Promise.all([
    searchIndexers(imdbId, season, episode),
    searchAll(imdbId, season, episode, config),
  ]);

  if (torrents.length === 0) {
    console.log(`[HebSubScout] No torrents found for ${imdbId}`);
    return { streams: [] };
  }

  console.log(`[HebSubScout] ${torrents.length} torrents, ${subtitles.length} subtitles for ${imdbId}`);

  // Check RD instant availability if user has RD token
  let cachedHashes = new Map();
  if (rdToken) {
    const hashes = torrents.map(t => t.hash);
    cachedHashes = await checkInstantAvailability(hashes, rdToken);
    console.log(`[HebSubScout] ${cachedHashes.size} cached on RD out of ${hashes.length}`);
  }

  // Build source objects for matching
  const sources = torrents.map(t => ({
    name: t.name,
    quality: t.quality || detectQuality(t.name),
    info: detectInfo(t.name),
    size: t.size,
    seeders: t.seeders,
    tracker: t.source,
    infoHash: t.hash,
    isCached: cachedHashes.has(t.hash),
  }));

  // Enrich with Hebrew subtitle match %
  const enriched = enrichStreams(sources, subtitles);
  for (const src of enriched) {
    src._subsChecked = subtitles.length > 0;
  }

  // Sort: cached first, then by quality tier, then by match %
  enriched.sort((a, b) => {
    // Cached always first
    if (a.isCached !== b.isCached) return a.isCached ? -1 : 1;
    const qualityOrder = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'SD': 4 };
    const qa = qualityOrder[a.quality] || 99;
    const qb = qualityOrder[b.quality] || 99;
    if (qa !== qb) return qa - qb;
    return (b.matchPct || 0) - (a.matchPct || 0);
  });

  // Resolve cached torrents through RD for direct HTTP links
  // Resolve top 15 cached to avoid rate limits
  const cachedSources = enriched.filter(s => s.isCached).slice(0, 15);
  const uncachedSources = enriched.filter(s => !s.isCached);

  let resolvedStreams = [];

  if (rdToken && cachedSources.length > 0) {
    const resolveResults = await Promise.allSettled(
      cachedSources.map(async (src) => {
        const resolved = await resolveTorrent(src.infoHash, rdToken);
        return { src, resolved };
      })
    );

    for (const result of resolveResults) {
      if (result.status !== 'fulfilled') continue;
      const { src, resolved } = result.value;
      if (resolved && resolved.url) {
        resolvedStreams.push({
          url: resolved.url,
          title: buildStreamTitle({ ...src, isCached: true }),
          name: `⚡ RD\n${src.quality || ''}`,
          behaviorHints: {
            filename: resolved.filename || src.name,
            videoSize: resolved.filesize || undefined,
          },
        });
      }
    }
  }

  // Also return uncached torrents as regular magnet streams (fallback)
  const magnetStreams = uncachedSources.slice(0, 20).map(src => ({
    infoHash: src.infoHash,
    title: buildStreamTitle(src),
    name: `${src.tracker || 'P2P'}\n${src.quality || ''}`,
    behaviorHints: { filename: src.name },
  }));

  const streams = [...resolvedStreams, ...magnetStreams];
  console.log(`[HebSubScout] Returning ${resolvedStreams.length} RD + ${magnetStreams.length} P2P streams`);
  return { streams };
});

// =========================================================================
// SUBTITLE HANDLER
// =========================================================================

builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
  console.log(`[HebSubScout] Subtitle request: ${type} ${id}`);
  const { imdbId, season, episode } = parseId(id);
  const config = getConfig(requestConfig);

  const subtitles = await searchAll(imdbId, season, episode, config);

  if (subtitles.length === 0) {
    return { subtitles: [] };
  }

  // If we know the source name (from behaviorHints or filename), sort by match quality
  const videoName = (extra && extra.filename) || '';
  let sorted = subtitles;

  if (videoName) {
    console.log(`[HebSubScout] Matching subtitles against: ${videoName}`);
    const matches = matchSource(videoName, subtitles, 0);
    sorted = matches.length > 0 ? matches : subtitles;
  }

  // Build the base URL for proxied downloads
  const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${port}`;

  // All subtitle downloads proxy through us (encoding fix: Win-1255 → UTF-8)
  const result = sorted.map((sub) => {
    const rawUrl = sub.downloadUrl || '';
    if (!rawUrl || rawUrl.startsWith('PROXY:')) return null;

    const encodedUrl = Buffer.from(rawUrl).toString('base64url');
    const proxyUrl = `${baseUrl}/proxy/sub/${encodedUrl}`;

    return {
      id: `hebsubscout-${sub.provider}-${sub.id}`,
      url: proxyUrl,
      lang: 'heb',
    };
  }).filter(Boolean);

  console.log(`[HebSubScout] Returning ${result.length} Hebrew subtitles for ${imdbId}`);
  return { subtitles: result };
});

// =========================================================================
// SERVER (custom Express app with Ktuvit download proxy)
// =========================================================================

const port = process.env.PORT || 7070;

const addonRouter = getRouter(builder.getInterface());

// Known Stremio addon URL path prefixes
const ADDON_PATHS = ['/manifest.json', '/stream/', '/subtitles/', '/meta/', '/catalog/'];

const server = http.createServer((req, res) => {
  // CORS headers for Stremio/Nuvio
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  let url = req.url || '/';

  // Extract per-user config from URL path prefix.
  // Pattern: /{base64config}/manifest.json, /{base64config}/stream/..., etc.
  // If no config prefix, fall through to env var config.
  requestConfig = null;
  const pathParts = url.split('/').filter(Boolean);
  if (pathParts.length >= 2) {
    const possibleConfig = pathParts[0];
    const rest = '/' + pathParts.slice(1).join('/');
    if (ADDON_PATHS.some(p => rest.startsWith(p))) {
      const decoded = decodeConfig(possibleConfig);
      if (decoded) {
        requestConfig = decoded;
        url = rest;
        req.url = rest;
      }
    }
  }

  // Universal subtitle proxy — downloads, unzips, re-encodes to UTF-8
  if (url.startsWith('/proxy/sub/')) {
    const encoded = url.split('/proxy/sub/')[1];
    if (!encoded) { res.writeHead(400); res.end('Missing URL'); return; }

    const originalUrl = Buffer.from(encoded, 'base64url').toString();
    const fetch = require('node-fetch');
    const zlib = require('zlib');

    fetch(originalUrl, { timeout: 15000, headers: { 'User-Agent': 'HebSubScout/2.0' } })
      .then(async (dlResp) => {
        if (!dlResp.ok) { res.writeHead(502); res.end('Download failed'); return; }
        const buf = await dlResp.buffer();

        let srtContent = null;

        // Check if it's a ZIP file (PK header)
        if (buf[0] === 0x50 && buf[1] === 0x4B) {
          // Parse ZIP manually — find the first .srt file
          try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(buf);
            const entries = zip.getEntries();
            const srtEntry = entries.find(e => /\.srt$/i.test(e.entryName));
            if (srtEntry) {
              srtContent = srtEntry.getData();
            }
          } catch {
            // If adm-zip not available, try returning raw ZIP
            res.writeHead(200, { 'Content-Type': 'application/zip' });
            res.end(buf);
            return;
          }
        } else {
          srtContent = buf;
        }

        if (!srtContent) { res.writeHead(404); res.end('No SRT found'); return; }

        // Detect and convert encoding to UTF-8
        let text;
        // Check for UTF-8 BOM or valid UTF-8
        const hasUtf8Bom = srtContent[0] === 0xEF && srtContent[1] === 0xBB && srtContent[2] === 0xBF;
        if (hasUtf8Bom || isValidUtf8(srtContent)) {
          text = srtContent.toString('utf-8');
        } else {
          // Assume Windows-1255 (Hebrew) and convert
          const iconv = require('iconv-lite');
          text = iconv.decode(srtContent, 'windows-1255');
        }

        const utf8Buf = Buffer.from(text, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/srt; charset=utf-8',
          'Content-Disposition': 'attachment; filename="subtitle.srt"',
        });
        res.end(utf8Buf);
      })
      .catch(err => {
        console.error('[HebSubScout] Subtitle proxy error:', err.message);
        res.writeHead(502);
        res.end('Download failed');
      });
    return;
  }

  // Ktuvit subtitle download proxy
  if (url.startsWith('/proxy/ktuvit/')) {
    const subId = url.split('/proxy/ktuvit/')[1];
    if (!subId) {
      res.writeHead(400);
      res.end('Missing subtitle ID');
      return;
    }

    const config = getConfig(requestConfig);
    downloadKtuvit(subId, config.ktuvitEmail, config.ktuvitPassword)
      .then(result => {
        if (!result) {
          res.writeHead(404);
          res.end('Subtitle not found or Ktuvit auth failed');
          return;
        }
        res.writeHead(200, {
          'Content-Type': result.contentType,
          'Content-Disposition': `attachment; filename="${subId}.srt"`,
        });
        res.end(result.buffer);
      })
      .catch(err => {
        console.error('Ktuvit proxy error:', err.message);
        res.writeHead(500);
        res.end('Download failed');
      });
    return;
  }

  // Debug endpoint — check indexer accessibility from server
  if (url === '/debug/indexers') {
    const { searchYTS, searchEZTV, searchIndexers } = require('./lib/indexers');
    Promise.allSettled([
      searchYTS('tt0111161'),
      searchEZTV('tt0944947', 1, 1),
      searchIndexers('tt0111161', null, null),
    ]).then(results => {
      const report = {
        yts_shawshank: { status: results[0].status, count: results[0].value?.length || 0, sample: results[0].value?.[0]?.name || results[0].reason?.message },
        eztv_got: { status: results[1].status, count: results[1].value?.length || 0, sample: results[1].value?.[0]?.name || results[1].reason?.message },
        combined_shawshank: { status: results[2].status, count: results[2].value?.length || 0, sample: results[2].value?.[0]?.name || results[2].reason?.message },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report, null, 2));
    });
    return;
  }

  // Serve configure page (web installer)
  if (url === '/' || url === '/configure' || url === '/configure.html') {
    const htmlPath = path.join(__dirname, 'configure.html');
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Could not load configure page');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // All other requests go to stremio-addon-sdk router
  addonRouter(req, res, () => {
    res.writeHead(404);
    res.end('Not Found');
  });
});

server.listen(port, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   HebSubScout Stremio Addon v${manifest.version}                    ║
║   Hebrew subtitle intelligence — free & open source   ║
║                                                       ║
║   Running on: http://localhost:${port}                    ║
║   Install:    http://localhost:${port}/manifest.json      ║
╠═══════════════════════════════════════════════════════╣
║   Add this URL in Stremio or Nuvio to install.        ║
╚═══════════════════════════════════════════════════════╝
`);
});
