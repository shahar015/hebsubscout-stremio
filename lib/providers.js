/**
 * Hebrew Subtitle Providers — Wizdom.xyz, Ktuvit.me, OpenSubtitles
 * Ported from script.module.hebsubscout/lib/hebsubscout/providers.py
 */

const fetch = require('node-fetch');
const cache = require('./cache');

// =========================================================================
// WIZDOM.XYZ
// =========================================================================

async function searchWizdom(imdbId, season, episode) {
  const cacheKey = `wizdom:${imdbId}:${season || 0}:${episode || 0}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    let url = `https://wizdom.xyz/api/search?action=by_id&imdb=${imdbId}`;
    if (season != null && episode != null) {
      url += `&season=${season}&episode=${episode}`;
    }

    const resp = await fetch(url, { timeout: 8000 });
    if (!resp.ok) return [];
    const data = await resp.json();

    let results = [];

    if (Array.isArray(data)) {
      // Direct array response
      results = data
        .filter(s => (s.versioname || s.version) && s.id)
        .map(s => ({
          id: String(s.id),
          name: s.versioname || s.version || '',
          provider: 'wizdom',
          downloadUrl: `https://wizdom.xyz/api/files/sub/${s.id}`,
        }));
    }

    // Fallback: releases endpoint
    if (results.length === 0) {
      try {
        const fallbackResp = await fetch(`https://wizdom.xyz/api/releases/${imdbId}`, { timeout: 8000 });
        if (fallbackResp.ok) {
          const fallbackData = await fallbackResp.json();
          if (fallbackData && fallbackData.subs) {
            let subs = fallbackData.subs;
            // TV: nested subs[season][episode]
            if (season != null && episode != null && subs[season]) {
              subs = subs[season][episode] || [];
            }
            if (Array.isArray(subs)) {
              results = subs
                .filter(s => (s.versioname || s.version) && s.id)
                .map(s => ({
                  id: String(s.id),
                  name: s.versioname || s.version || '',
                  provider: 'wizdom',
                  downloadUrl: `https://wizdom.xyz/api/files/sub/${s.id}`,
                }));
            }
          }
        }
      } catch (e) { /* fallback failed, ignore */ }
    }

    cache.set(cacheKey, results);
    return results;
  } catch (e) {
    console.error('Wizdom error:', e.message);
    return [];
  }
}

// =========================================================================
// KTUVIT.ME
// =========================================================================

let ktuvitCookies = '';
let ktuvitLoggedIn = false;

async function ktuvitLogin(email, hashedPassword) {
  if (ktuvitLoggedIn && ktuvitCookies) return true;
  if (!email || !hashedPassword) return false;

  try {
    const resp = await fetch('https://www.ktuvit.me/Services/MembershipService.svc/Login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: { Email: email, Password: hashedPassword } }),
      timeout: 10000,
    });

    if (!resp.ok) return false;

    // Extract cookies
    const setCookies = resp.headers.raw()['set-cookie'] || [];
    ktuvitCookies = setCookies.map(c => c.split(';')[0]).join('; ');

    const body = await resp.json();
    const d = typeof body.d === 'string' ? JSON.parse(body.d) : body.d;
    if (d && d.IsSuccess) {
      ktuvitLoggedIn = true;
      return true;
    }
    return false;
  } catch (e) {
    console.error('Ktuvit login error:', e.message);
    return false;
  }
}

async function searchKtuvit(imdbId, season, episode, email, hashedPassword) {
  const cacheKey = `ktuvit:${imdbId}:${season || 0}:${episode || 0}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  if (!await ktuvitLogin(email, hashedPassword)) return [];

  try {
    // Step 1: Find the title on Ktuvit
    const searchType = (season != null) ? '1' : '0'; // 1=TV, 0=Movie
    const searchResp = await fetch('https://www.ktuvit.me/Services/ContentProvider.svc/SearchPage_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': ktuvitCookies,
      },
      body: JSON.stringify({
        request: {
          FilmName: imdbId,
          Actors: [], Studios: null, Directors: [], Genres: [],
          Countries: [], Languages: [], Year: '', Rating: [],
          Page: 1, SearchType: searchType, WithSubsOnly: false,
        }
      }),
      timeout: 10000,
    });

    if (!searchResp.ok) return [];
    const searchBody = await searchResp.json();
    const searchData = typeof searchBody.d === 'string' ? JSON.parse(searchBody.d) : searchBody.d;

    if (!searchData || !searchData.Films || searchData.Films.length === 0) return [];
    const ktuvitId = searchData.Films[0].ID;

    // Step 2: Get subtitles
    let subsUrl;
    if (season != null && episode != null) {
      subsUrl = `https://www.ktuvit.me/Services/GetModuleAjax.ashx?moduleName=SubtitlesList&SeriesID=${ktuvitId}&Season=${season}&Episode=${episode}`;
    } else {
      subsUrl = `https://www.ktuvit.me/MovieInfo.aspx?ID=${ktuvitId}`;
    }

    const subsResp = await fetch(subsUrl, {
      headers: { 'Cookie': ktuvitCookies },
      timeout: 10000,
    });
    if (!subsResp.ok) return [];
    const html = await subsResp.text();

    // Parse HTML for subtitle entries
    const results = [];
    const subIdPattern = /data-(?:subtitle|sub)-id="([^"]+)"/g;
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/g;

    let rowMatch;
    while ((rowMatch = rowPattern.exec(html)) !== null) {
      const row = rowMatch[1];
      const idMatch = /data-(?:subtitle|sub)-id="([^"]+)"/.exec(row);
      if (!idMatch) continue;

      const subId = idMatch[1];
      const cells = [];
      let cellMatch;
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
      while ((cellMatch = cellRe.exec(row)) !== null) {
        cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
      }

      if (cells.length > 0 && cells[0]) {
        results.push({
          id: `${ktuvitId}:${subId}`,
          name: cells[0],
          provider: 'ktuvit',
          // Download via our proxy (Ktuvit requires auth cookies)
          downloadUrl: `PROXY:ktuvit:${subId}`,
          _ktuvitSubId: subId,
        });
      }
    }

    cache.set(cacheKey, results);
    return results;
  } catch (e) {
    console.error('Ktuvit error:', e.message);
    return [];
  }
}

// =========================================================================
// OPENSUBTITLES
// =========================================================================

async function searchOpenSubs(imdbId, season, episode, apiKey) {
  if (!apiKey) return [];

  const cacheKey = `opensubs:${imdbId}:${season || 0}:${episode || 0}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    // Remove 'tt' prefix for numeric ID
    const numericId = imdbId.replace('tt', '');
    let url = `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${numericId}&languages=he`;
    if (season != null) url += `&season_number=${season}`;
    if (episode != null) url += `&episode_number=${episode}`;

    const resp = await fetch(url, {
      headers: {
        'Api-Key': apiKey,
        'Accept': 'application/json',
      },
      timeout: 8000,
    });

    if (!resp.ok) return [];
    const data = await resp.json();

    const items = (data.data || []).map(item => {
      const attr = item.attributes || {};
      const fileId = (attr.files && attr.files[0]) ? attr.files[0].file_id : null;
      if (!fileId) return null;
      return {
        id: String(fileId),
        name: attr.release || (attr.feature_details || {}).title || '',
        provider: 'opensubtitles',
        downloadUrl: '', // Filled by download call
        _fileId: fileId,
      };
    }).filter(s => s && s.name);

    // Fetch download URLs for top results (OpenSubtitles rate limits, so limit to 5)
    const topItems = items.slice(0, 5);
    await Promise.allSettled(topItems.map(async (item) => {
      try {
        const dlResp = await fetch('https://api.opensubtitles.com/api/v1/download', {
          method: 'POST',
          headers: {
            'Api-Key': apiKey,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ file_id: item._fileId }),
          timeout: 8000,
        });
        if (dlResp.ok) {
          const dlData = await dlResp.json();
          item.downloadUrl = dlData.link || '';
        }
      } catch (e) { /* download URL fetch failed, skip */ }
    }));

    const results = topItems.filter(s => s.downloadUrl);
    cache.set(cacheKey, results);
    return results;
  } catch (e) {
    console.error('OpenSubtitles error:', e.message);
    return [];
  }
}

// =========================================================================
// COMBINED SEARCH
// =========================================================================

/**
 * Search all providers in parallel. Returns combined subtitle list.
 */
async function searchAll(imdbId, season, episode, config = {}) {
  const cacheKey = `all:${imdbId}:${season || 0}:${episode || 0}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const promises = [
    searchWizdom(imdbId, season, episode),
    searchKtuvit(imdbId, season, episode, config.ktuvitEmail, config.ktuvitPassword),
    searchOpenSubs(imdbId, season, episode, config.opensubsApiKey),
  ];

  const results = await Promise.allSettled(promises);
  const allSubs = [];

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      allSubs.push(...result.value);
    }
  }

  console.log(`[HebSubScout] Found ${allSubs.length} Hebrew subtitles for ${imdbId}`);
  cache.set(cacheKey, allSubs);
  return allSubs;
}

/**
 * Download a Ktuvit subtitle file (proxied, since it requires auth cookies).
 * Returns { buffer, contentType } or null.
 */
async function downloadKtuvit(subId, email, hashedPassword) {
  if (!await ktuvitLogin(email, hashedPassword)) return null;

  try {
    // First get the download identifier
    const identResp = await fetch('https://www.ktuvit.me/Services/ContentProvider.svc/RequestSubtitleDownload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': ktuvitCookies,
      },
      body: JSON.stringify({ request: { FilmID: '', SubtitleID: subId, FontSize: 0, FontColor: '', PredefinedLayout: -1 } }),
      timeout: 10000,
    });

    if (!identResp.ok) return null;
    const identBody = await identResp.json();
    const identData = typeof identBody.d === 'string' ? JSON.parse(identBody.d) : identBody.d;
    const downloadId = identData && identData.DownloadIdentifier;
    if (!downloadId) return null;

    // Now download the actual file
    const dlResp = await fetch(`https://www.ktuvit.me/Services/DownloadFile.ashx?DownloadIdentifier=${downloadId}`, {
      headers: { 'Cookie': ktuvitCookies },
      timeout: 15000,
    });

    if (!dlResp.ok) return null;
    const buffer = await dlResp.buffer();
    const contentType = dlResp.headers.get('content-type') || 'application/octet-stream';
    return { buffer, contentType };
  } catch (e) {
    console.error('Ktuvit download error:', e.message);
    return null;
  }
}

module.exports = { searchWizdom, searchKtuvit, searchOpenSubs, searchAll, downloadKtuvit };
