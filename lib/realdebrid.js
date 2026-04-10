/**
 * Real-Debrid API client.
 * Handles: instant availability check, torrent add/resolve, unrestrict links.
 */

const fetch = require('node-fetch');
const cache = require('./cache');

const RD_BASE = 'https://api.real-debrid.com/rest/1.0';

function rdFetch(path, apiToken, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 10000);
  return fetch(`${RD_BASE}${path}`, {
    ...options,
    signal: controller.signal,
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      ...options.headers,
    },
  }).finally(() => clearTimeout(timer));
}

/**
 * Check which torrent hashes are instantly available (cached) on RD.
 * Returns a Map of hash → array of file variants.
 * Each variant is { fileId, filename, filesize }.
 */
async function checkInstantAvailability(hashes, apiToken) {
  if (!hashes.length || !apiToken) return new Map();

  // RD accepts up to ~100 hashes per request
  const batchSize = 50;
  const results = new Map();

  for (let i = 0; i < hashes.length; i += batchSize) {
    const batch = hashes.slice(i, i + batchSize);
    const hashStr = batch.join('/');
    const cacheKey = `rd:avail:${hashStr.slice(0, 60)}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      for (const [k, v] of cached) results.set(k, v);
      continue;
    }

    try {
      const resp = await rdFetch(`/torrents/instantAvailability/${hashStr}`, apiToken);
      if (!resp.ok) continue;
      const data = await resp.json();

      const batchResults = new Map();
      for (const [hash, hosters] of Object.entries(data)) {
        if (!hosters || typeof hosters !== 'object') continue;
        // RD returns { "rd": [{ "1": { filename, filesize } }, ...] }
        const rd = hosters.rd;
        if (!Array.isArray(rd) || rd.length === 0) continue;

        const files = [];
        for (const variant of rd) {
          for (const [fileId, info] of Object.entries(variant)) {
            if (info && info.filename) {
              files.push({
                fileId: parseInt(fileId),
                filename: info.filename,
                filesize: info.filesize || 0,
              });
            }
          }
        }
        if (files.length > 0) {
          results.set(hash.toLowerCase(), files);
          batchResults.set(hash.toLowerCase(), files);
        }
      }
      cache.set(cacheKey, batchResults, 5 * 60 * 1000); // 5 min cache
    } catch (e) {
      console.error('[RD] Instant availability error:', e.message);
    }
  }

  return results;
}

/**
 * Add a magnet link to RD and resolve to a direct download URL.
 * Returns { url, filename, filesize } or null.
 */
async function resolveTorrent(infoHash, apiToken) {
  if (!infoHash || !apiToken) return null;

  const cacheKey = `rd:resolve:${infoHash}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    // Step 1: Add magnet
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;
    const addResp = await rdFetch('/torrents/addMagnet', apiToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `magnet=${encodeURIComponent(magnet)}`,
    });
    if (!addResp.ok) return null;
    const addData = await addResp.json();
    const torrentId = addData.id;
    if (!torrentId) return null;

    // Step 2: Get torrent info to find files
    const infoResp = await rdFetch(`/torrents/info/${torrentId}`, apiToken);
    if (!infoResp.ok) return null;
    const infoData = await infoResp.json();

    // Step 3: Select the largest video file
    const videoExts = ['.mkv', '.mp4', '.avi', '.mov', '.wmv'];
    let bestFile = null;
    for (const file of (infoData.files || [])) {
      const name = (file.path || '').toLowerCase();
      if (videoExts.some(ext => name.endsWith(ext))) {
        if (!bestFile || file.bytes > bestFile.bytes) {
          bestFile = file;
        }
      }
    }

    if (!bestFile) {
      // Select all and hope for the best
      await rdFetch(`/torrents/selectFiles/${torrentId}`, apiToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'files=all',
      });
    } else {
      await rdFetch(`/torrents/selectFiles/${torrentId}`, apiToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `files=${bestFile.id}`,
      });
    }

    // Step 4: Wait briefly, then get the download link
    const info2Resp = await rdFetch(`/torrents/info/${torrentId}`, apiToken);
    if (!info2Resp.ok) return null;
    const info2Data = await info2Resp.json();

    const links = info2Data.links || [];
    if (links.length === 0) return null;

    // Step 5: Unrestrict the first link to get direct URL
    const unrestrictResp = await rdFetch('/unrestrict/link', apiToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `link=${encodeURIComponent(links[0])}`,
    });
    if (!unrestrictResp.ok) return null;
    const dlData = await unrestrictResp.json();

    const result = {
      url: dlData.download || '',
      filename: dlData.filename || '',
      filesize: dlData.filesize || 0,
    };

    if (result.url) {
      cache.set(cacheKey, result, 30 * 60 * 1000); // 30 min cache
    }
    return result;
  } catch (e) {
    console.error('[RD] Resolve error:', e.message);
    return null;
  }
}

module.exports = { checkInstantAvailability, resolveTorrent };
