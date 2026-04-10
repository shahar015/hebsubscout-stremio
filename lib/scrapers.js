/**
 * Source scrapers — Torrentio + MediaFusion
 * Ported from plugin.video.hebscout/resources/lib/scrapers/__init__.py
 */

const fetch = require('node-fetch');

// =========================================================================
// QUALITY & INFO DETECTION
// =========================================================================

function detectQuality(name) {
  const n = name.toLowerCase();
  if (/2160p|4k|uhd/.test(n)) return '4K';
  if (/1080p/.test(n)) return '1080p';
  if (/720p/.test(n)) return '720p';
  if (/480p/.test(n)) return '480p';
  return 'SD';
}

function detectInfo(name) {
  const n = name.toLowerCase();
  const info = [];
  // Codec
  if (/hevc|x265|h\.?265/.test(n)) info.push('H.265');
  else if (/x264|h\.?264/.test(n)) info.push('H.264');
  else if (/\bav1\b/.test(n)) info.push('AV1');
  // HDR
  if (/dolby\.?vision|\.dv\.|dovi/.test(n)) info.push('DV');
  if (/hdr10\+|hdr10plus/.test(n)) info.push('HDR10+');
  else if (/hdr10/.test(n)) info.push('HDR10');
  else if (/\bhdr\b/.test(n)) info.push('HDR');
  // Release
  if (/remux/.test(n)) info.push('REMUX');
  if (/blu-?ray/.test(n)) info.push('BluRay');
  else if (/web-?dl/.test(n)) info.push('WEB-DL');
  else if (/webrip/.test(n)) info.push('WEBRip');
  // Audio
  if (/atmos/.test(n)) info.push('Atmos');
  if (/truehd/.test(n)) info.push('TrueHD');
  if (/dts-?hd/.test(n)) info.push('DTS-HD');
  else if (/\bdts\b/.test(n)) info.push('DTS');
  if (/ddp5|dd\+|eac3/.test(n)) info.push('DD+');
  else if (/dd5|ac3/.test(n)) info.push('DD5.1');
  else if (/\baac\b/.test(n)) info.push('AAC');
  return info;
}

function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 ** 2))} MB`;
}

/**
 * Extract clean size string from Torrentio title line.
 * Torrentio format: "👤 15 💾 15.4 GB ⚙️ ThePirateBay"
 */
function extractSizeFromTitle(title) {
  const sizeMatch = /(\d+(?:\.\d+)?\s*[GT]B)/i.exec(title);
  return sizeMatch ? sizeMatch[1] : '';
}

/**
 * Extract seeders count from Torrentio title line.
 */
function extractSeeders(title) {
  const match = /👤\s*(\d+)/.exec(title);
  return match ? parseInt(match[1]) : 0;
}

/**
 * Extract tracker/indexer name from Torrentio title line.
 */
function extractTracker(title) {
  const match = /⚙️\s*(.+?)(?:\n|$)/.exec(title);
  return match ? match[1].trim() : '';
}

// =========================================================================
// STREMIO-COMPATIBLE SCRAPER
// =========================================================================

async function scrapeStremio(baseUrl, providerName, type, id) {
  try {
    const url = `${baseUrl}/stream/${type}/${id}.json`;
    const resp = await fetch(url, { timeout: 15000 });
    if (!resp.ok) return [];
    const data = await resp.json();

    return (data.streams || []).map(stream => {
      const title = stream.title || stream.name || stream.description || '';
      const hints = stream.behaviorHints || {};
      let releaseName = hints.filename || '';

      if (!releaseName) {
        // First line of title is usually the release name
        const firstLine = title.split('\n')[0] || '';
        // Strip emojis and clean up
        releaseName = firstLine.replace(/[\u{1F300}-\u{1FAD6}]/gu, '').replace(/\s+/g, ' ').trim();
      }

      // Strip file extension from release name
      releaseName = releaseName.replace(/\.\w{2,4}$/, '');

      // Extract structured metadata from Torrentio title lines
      const size = hints.videoSize ? formatSize(hints.videoSize) : extractSizeFromTitle(title);
      const seeders = extractSeeders(title);
      const tracker = extractTracker(title);

      return {
        name: releaseName,
        quality: detectQuality(releaseName),
        info: detectInfo(releaseName),
        size,
        seeders,
        tracker,
        infoHash: stream.infoHash || '',
        url: stream.url || '',
        fileIdx: stream.fileIdx,
        provider: providerName,
        type: stream.infoHash ? 'torrent' : (stream.url ? 'direct' : 'torrent'),
        _original: stream,
      };
    });
  } catch (e) {
    console.error(`${providerName} scrape error:`, e.message);
    return [];
  }
}

async function scrapeTorrentio(type, id) {
  return scrapeStremio('https://torrentio.strem.fun', 'Torrentio', type, id);
}

async function scrapeMediaFusion(type, id, configUrl) {
  if (!configUrl) return [];
  return scrapeStremio(configUrl, 'MediaFusion', type, id);
}

/**
 * Scrape all enabled sources in parallel. Deduplicate by infoHash.
 */
async function scrapeAll(type, id, config = {}) {
  const promises = [scrapeTorrentio(type, id)];
  if (config.mediafusionUrl) {
    promises.push(scrapeMediaFusion(type, id, config.mediafusionUrl));
  }

  const results = await Promise.allSettled(promises);
  const allSources = [];

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      allSources.push(...result.value);
    }
  }

  // Deduplicate by infoHash
  const seen = new Set();
  const unique = [];
  for (const src of allSources) {
    const hash = src.infoHash;
    if (hash && seen.has(hash.toLowerCase())) continue;
    if (hash) seen.add(hash.toLowerCase());
    unique.push(src);
  }

  // Sort: 4K > 1080p > 720p > SD
  const qualityOrder = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'SD': 4 };
  unique.sort((a, b) => (qualityOrder[a.quality] || 99) - (qualityOrder[b.quality] || 99));

  console.log(`[HebSubScout] Scraped ${unique.length} unique sources`);
  return unique;
}

module.exports = { scrapeTorrentio, scrapeMediaFusion, scrapeAll, detectQuality, detectInfo };
