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
const { scrapeAll } = require('./lib/scrapers');
const cache = require('./lib/cache');
const http = require('http');
const fs = require('fs');
const path = require('path');

// =========================================================================
// MANIFEST
// =========================================================================

const manifest = {
  id: 'com.hebsubscout.stremio',
  version: '1.0.0',
  name: 'HebSubScout',
  description: 'Hebrew subtitle intelligence — see match % on every source BEFORE you pick. Auto-selects best Hebrew subtitle. Free & open source.',
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

function buildStreamTitle(source) {
  const parts = [];

  // Quality + info tags
  let qualityStr = source.quality || '';
  if (source.info && source.info.length > 0) {
    qualityStr += ' ' + source.info.join(' ');
  }
  if (qualityStr.trim()) parts.push(qualityStr.trim());

  // Hebrew subtitle match indicator — THE KEY FEATURE
  if (source.matchPct > 0) {
    parts.push(`[עב ${source.matchPct}%]`);
  } else if (source.matchPct === 0 && source._subsChecked) {
    parts.push('[עב ✗]');
  }

  // Size + seeders
  const meta = [];
  if (source.size) meta.push(source.size);
  if (source.seeders > 0) meta.push(`👤 ${source.seeders}`);
  if (meta.length > 0) parts.push(meta.join(' '));

  // Tracker/indexer
  if (source.tracker) parts.push(source.tracker);

  return parts.join(' | ');
}

// =========================================================================
// STREAM HANDLER
// =========================================================================

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[HebSubScout] Stream request: ${type} ${id}`);
  const { imdbId, season, episode } = parseId(id);
  const config = getConfig(requestConfig);

  // Fetch sources and Hebrew subtitles in parallel
  const [sources, subtitles] = await Promise.all([
    scrapeAll(type, id, config),
    searchAll(imdbId, season, episode, config),
  ]);

  if (sources.length === 0) {
    return { streams: [] };
  }

  // Enrich each source with Hebrew subtitle match %
  const enriched = enrichStreams(sources, subtitles);

  // Mark that we checked subs (so we can show ✗ for no match)
  for (const src of enriched) {
    src._subsChecked = subtitles.length > 0;
  }

  // Sort: highest match % first (within same quality tier)
  enriched.sort((a, b) => {
    const qualityOrder = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'SD': 4 };
    const qa = qualityOrder[a.quality] || 99;
    const qb = qualityOrder[b.quality] || 99;
    if (qa !== qb) return qa - qb;
    return (b.matchPct || 0) - (a.matchPct || 0);
  });

  // Convert to Stremio stream objects
  const streams = enriched.map(src => {
    const stream = {};

    // Source: torrent hash or direct URL
    if (src.infoHash) {
      stream.infoHash = src.infoHash;
      if (src.fileIdx != null) stream.fileIdx = src.fileIdx;
    } else if (src.url) {
      stream.url = src.url;
    } else {
      return null; // Skip sources with no playable link
    }

    // Title with match % — THE KEY FEATURE
    stream.title = buildStreamTitle(src);

    // Name (shown in compact view) — provider + quality
    stream.name = `${src.provider}\n${src.quality || ''}`;

    // Behavior hints
    stream.behaviorHints = {};
    if (src._original && src._original.behaviorHints) {
      stream.behaviorHints = { ...src._original.behaviorHints };
    }

    return stream;
  }).filter(Boolean);

  console.log(`[HebSubScout] Returning ${streams.length} enriched streams for ${imdbId}`);
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
    const matches = matchSource(videoName, subtitles, 0);
    sorted = matches.length > 0 ? matches : subtitles;
  }

  // Build the base URL for proxied downloads
  // Render auto-sets RENDER_EXTERNAL_URL, otherwise fall back to BASE_URL or localhost
  const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${port}`;

  // Return as Stremio subtitle objects — best match first (auto-selected by Stremio)
  const result = sorted.map((sub) => {
    let url = sub.downloadUrl || '';

    // Replace proxy placeholder with actual proxy URL
    if (url.startsWith('PROXY:ktuvit:')) {
      const subId = url.replace('PROXY:ktuvit:', '');
      url = `${baseUrl}/proxy/ktuvit/${subId}`;
    }

    if (!url) return null;

    return {
      id: `hebsubscout-${sub.provider}-${sub.id}`,
      url,
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
