#!/usr/bin/env node
/**
 * HebSubScout — Stremio Addon
 * Hebrew subtitle intelligence: match % on every source, auto-select best subtitle.
 *
 * Works with Stremio AND Nuvio.
 * Free and open source alternative to "Heb Subs Premium".
 */

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { enrichStreams, matchSource } = require('./lib/matcher');
const { searchAll } = require('./lib/providers');
const { scrapeAll } = require('./lib/scrapers');
const cache = require('./lib/cache');

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

function getConfig() {
  // Config from environment variables (for self-hosted deployment)
  return {
    ktuvitEmail: process.env.KTUVIT_EMAIL || '',
    ktuvitPassword: process.env.KTUVIT_PASSWORD || '',
    opensubsApiKey: process.env.OPENSUBS_API_KEY || '',
    mediafusionUrl: process.env.MEDIAFUSION_URL || '',
  };
}

function buildStreamTitle(source) {
  const parts = [];

  // Quality + info tags
  let qualityStr = source.quality || '';
  if (source.info && source.info.length > 0) {
    qualityStr += ' ' + source.info.join(' ');
  }
  if (qualityStr.trim()) parts.push(qualityStr.trim());

  // Hebrew subtitle match indicator
  if (source.matchPct > 0) {
    parts.push(`[עב ${source.matchPct}%]`);
  } else if (source.matchPct === 0 && source._subsChecked) {
    parts.push('[עב ✗]');
  }

  // Provider
  parts.push(source.provider);

  // Size
  if (source.size) parts.push(source.size);

  return parts.join(' | ');
}

// =========================================================================
// STREAM HANDLER
// =========================================================================

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[HebSubScout] Stream request: ${type} ${id}`);
  const { imdbId, season, episode } = parseId(id);
  const config = getConfig();

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

    // Name (shorter, shown in compact view)
    stream.name = src.provider;

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
  const config = getConfig();

  const subtitles = await searchAll(imdbId, season, episode, config);

  if (subtitles.length === 0) {
    return { subtitles: [] };
  }

  // If we know the source name (from behaviorHints or filename), sort by match quality
  const videoName = (extra && extra.filename) || '';
  let sorted = subtitles;

  if (videoName) {
    const matches = matchSource(videoName, subtitles, 0); // Get all with scores
    sorted = matches.length > 0 ? matches : subtitles;
  }

  // Return as Stremio subtitle objects — best match first (auto-selected by Stremio)
  const result = sorted.map((sub, i) => ({
    id: `hebsubscout-${sub.provider}-${sub.id}`,
    url: sub.downloadUrl || '',
    lang: 'heb',
  })).filter(s => s.url); // Only include subs with download URLs

  console.log(`[HebSubScout] Returning ${result.length} Hebrew subtitles for ${imdbId}`);
  return { subtitles: result };
});

// =========================================================================
// SERVER
// =========================================================================

const port = process.env.PORT || 7070;
serveHTTP(builder.getInterface(), { port });
console.log(`
╔═══════════════════════════════════════════════════╗
║   HebSubScout Stremio Addon                       ║
║   Hebrew subtitle intelligence — free & open source║
║                                                   ║
║   Running on: http://localhost:${port}               ║
║   Install:    http://localhost:${port}/manifest.json  ║
╠═══════════════════════════════════════════════════╣
║   Add this URL in Stremio or Nuvio to install.    ║
╚═══════════════════════════════════════════════════╝
`);
