/**
 * Torrent indexers — search by IMDB ID, return hashes + release names.
 * YTS (movies) + EZTV (TV shows). Both work from cloud IPs.
 */

const fetch = require('node-fetch');
const cache = require('./cache');

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

function abortableFetch(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    signal: controller.signal,
    headers: { 'User-Agent': 'HebSubScout/1.0' },
  }).finally(() => clearTimeout(timer));
}

// =========================================================================
// YTS — Movies
// =========================================================================

const YTS_DOMAINS = ['yts.rs', 'yts.mx', 'yts.torrentbay.net'];

async function searchYTS(imdbId) {
  const cacheKey = `yts:${imdbId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let data = null;
  for (const domain of YTS_DOMAINS) {
    try {
      const resp = await abortableFetch(
        `https://${domain}/api/v2/movie_details.json?imdb_id=${imdbId}&with_images=false`
      );
      if (resp.ok) { data = await resp.json(); break; }
    } catch (e) { continue; }
  }

  try {
    if (!data) return [];

    const movie = data?.data?.movie;
    if (!movie || !movie.torrents) return [];

    const results = movie.torrents
      .filter(t => t.hash)
      .map(t => ({
        hash: t.hash.toLowerCase(),
        name: `${movie.title_long || movie.title} ${t.quality} ${t.type || ''}`.trim(),
        quality: t.quality || '',
        size: t.size || '',
        sizeBytes: t.size_bytes || 0,
        seeders: t.seeds || 0,
        source: 'YTS',
      }));

    cache.set(cacheKey, results, 60 * 60 * 1000); // 1 hour
    return results;
  } catch (e) {
    console.error('[Indexer] YTS error:', e.message);
    return [];
  }
}

// =========================================================================
// EZTV — TV Shows
// =========================================================================

const EZTV_DOMAINS = ['eztvx.to', 'eztv.re', 'eztv.wf'];

async function searchEZTV(imdbId, season, episode) {
  const numericId = imdbId.replace('tt', '');
  const cacheKey = `eztv:${numericId}:${season || 0}:${episode || 0}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    let page = 1;
    let allTorrents = [];
    let workingDomain = EZTV_DOMAINS[0];

    // Find a working domain
    for (const domain of EZTV_DOMAINS) {
      try {
        const testResp = await abortableFetch(
          `https://${domain}/api/get-torrents?imdb_id=${numericId}&limit=1&page=1`, 5000
        );
        if (testResp.ok) { workingDomain = domain; break; }
      } catch { continue; }
    }

    // EZTV paginates, fetch up to 3 pages
    while (page <= 3) {
      const resp = await abortableFetch(
        `https://${workingDomain}/api/get-torrents?imdb_id=${numericId}&limit=100&page=${page}`
      );
      if (!resp.ok) break;
      const data = await resp.json();

      const torrents = data?.torrents || [];
      if (torrents.length === 0) break;
      allTorrents.push(...torrents);

      if (torrents.length < 100) break;
      page++;
    }

    let results = allTorrents
      .filter(t => t.hash && t.filename)
      .map(t => ({
        hash: t.hash.toLowerCase(),
        name: t.filename || t.title || '',
        quality: detectQualityFromName(t.filename || ''),
        size: formatBytes(t.size_bytes),
        sizeBytes: t.size_bytes || 0,
        seeders: t.seeds || 0,
        season: t.season ? parseInt(t.season) : null,
        episode: t.episode ? parseInt(t.episode) : null,
        source: 'EZTV',
      }));

    // Filter to specific episode if requested
    if (season != null && episode != null) {
      const seStr = `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`;
      results = results.filter(t => {
        // Match by parsed season/episode or by name pattern
        if (t.season === season && t.episode === episode) return true;
        return t.name.toLowerCase().includes(seStr);
      });
    }

    cache.set(cacheKey, results, 60 * 60 * 1000);
    return results;
  } catch (e) {
    console.error('[Indexer] EZTV error:', e.message);
    return [];
  }
}

// =========================================================================
// Helpers
// =========================================================================

function detectQualityFromName(name) {
  const n = name.toLowerCase();
  if (/2160p|4k|uhd/.test(n)) return '4K';
  if (/1080p/.test(n)) return '1080p';
  if (/720p/.test(n)) return '720p';
  if (/480p/.test(n)) return '480p';
  return 'SD';
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 ** 2))} MB`;
}

/**
 * Search all indexers by IMDB ID. Returns combined torrent list.
 */
async function searchIndexers(imdbId, season, episode) {
  const isTV = season != null && episode != null;

  const promises = isTV
    ? [searchEZTV(imdbId, season, episode)]
    : [searchYTS(imdbId)];

  // Always try both for better coverage
  if (!isTV) promises.push(searchEZTV(imdbId, null, null));
  if (isTV) promises.push(searchYTS(imdbId)); // Some movies are tagged as TV

  const results = await Promise.allSettled(promises);
  const all = [];

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      all.push(...result.value);
    }
  }

  // Deduplicate by hash
  const seen = new Set();
  const unique = [];
  for (const t of all) {
    if (seen.has(t.hash)) continue;
    seen.add(t.hash);
    unique.push(t);
  }

  // Sort: most seeders first
  unique.sort((a, b) => b.seeders - a.seeders);

  console.log(`[Indexer] Found ${unique.length} torrents for ${imdbId}${isTV ? ` S${season}E${episode}` : ''}`);
  return unique;
}

module.exports = { searchYTS, searchEZTV, searchIndexers };
