/**
 * HebSubScout Matcher — Release name fuzzy matching algorithm.
 * Ported from script.module.hebsubscout/lib/hebsubscout/matcher.py
 *
 * Scores 0-100 how well a subtitle release name matches a video source name.
 * Components: title (30), quality (25), group (20), codec (10), season/episode (10), audio (5)
 */

const stringSimilarity = require('string-similarity');

// --- Pattern sets ---
const QUALITY = new Set([
  'remux','2160p','4k','uhd','1080p','1080i','720p','480p','360p',
  'hdtv','hdrip','bdrip','brrip','bluray','blu-ray','webdl','web-dl',
  'webrip','web-rip','web','dvdrip','dvdscr','hdcam','cam','ts',
  'telesync','telecine','screener','pdtv','sdtv','hdr','hdr10',
  'dolby.vision','dv','sdr','imax'
]);

const CODEC = new Set([
  'x264','x265','h264','h.264','h265','h.265','hevc','avc',
  'xvid','divx','mpeg','mpeg2','av1','vp9','vc1','vc-1'
]);

const AUDIO = new Set([
  'dts','dts-hd','dts-hd.ma','dts-x','truehd','atmos',
  'dd5.1','ddp5.1','dd2.0','ac3','aac','aac2.0','aac5.1',
  'flac','eac3','mp3','opus','pcm','lpcm','dolby'
]);

const SE_RE = /[Ss](\d{1,2})[Ee](\d{1,2})/;
const YEAR_RE = /(?:19|20)\d{2}/;
const GROUP_RE = /-([A-Za-z0-9]+)(?:\.\w{2,4})?$/;

/**
 * Normalize a release name: replace separators with dots, lowercase.
 */
function normalize(name) {
  let n = name.replace(/[\s\-_\[\]\(\)]/g, '.');
  n = n.replace(/\.{2,}/g, '.');
  n = n.replace(/^\.+|\.+$/g, '');
  return n.toLowerCase();
}

/**
 * Extract structured components from a release name.
 */
function extractComponents(name) {
  const norm = normalize(name);
  const tokens = norm.split('.');

  const components = {
    quality: [],
    codec: [],
    audio: [],
    group: '',
    seasonEpisode: '',
    year: '',
    titleTokens: [],
    allTokens: new Set(tokens),
  };

  // Season/episode
  const seMatch = SE_RE.exec(norm);
  if (seMatch) components.seasonEpisode = seMatch[0].toLowerCase();

  // Year
  const yearMatch = YEAR_RE.exec(name);
  if (yearMatch) components.year = yearMatch[0];

  // Categorize tokens
  let titleEnded = false;
  for (const token of tokens) {
    const t = token.toLowerCase();
    if (QUALITY.has(t)) { components.quality.push(t); titleEnded = true; }
    else if (CODEC.has(t)) { components.codec.push(t); titleEnded = true; }
    else if (AUDIO.has(t)) { components.audio.push(t); titleEnded = true; }
    else if (YEAR_RE.test(token)) { titleEnded = true; }
    else if (SE_RE.test(token)) { titleEnded = true; }
    else if (!titleEnded) { components.titleTokens.push(t); }
  }

  // Release group
  const groupMatch = GROUP_RE.exec(name);
  if (groupMatch) components.group = groupMatch[1].toLowerCase();

  return components;
}

// Simple LRU-ish cache for extractComponents
const componentCache = new Map();
const CACHE_MAX = 256;

function cachedExtract(name) {
  if (componentCache.has(name)) return componentCache.get(name);
  const result = extractComponents(name);
  if (componentCache.size >= CACHE_MAX) {
    const firstKey = componentCache.keys().next().value;
    componentCache.delete(firstKey);
  }
  componentCache.set(name, result);
  return result;
}

/**
 * Compute match score (0-100) between a source name and subtitle name.
 */
function computeMatchScore(sourceName, subtitleName) {
  const srcNorm = normalize(sourceName);
  const subNorm = normalize(subtitleName);

  // Quick checks
  if (srcNorm === subNorm) return 100;
  if (srcNorm.includes(subNorm) || subNorm.includes(srcNorm)) return 95;

  const src = cachedExtract(sourceName);
  const sub = cachedExtract(subtitleName);

  let totalPoints = 0;
  let maxPoints = 0;

  // 1. Title match (30 points)
  if (src.titleTokens.length > 0 && sub.titleTokens.length > 0) {
    const srcTitle = src.titleTokens.join('.');
    const subTitle = sub.titleTokens.join('.');
    const ratio = stringSimilarity.compareTwoStrings(srcTitle, subTitle);
    totalPoints += ratio * 30;
    maxPoints += 30;
  }

  // 2. Quality match (25 points)
  maxPoints += 25;
  if (src.quality.length > 0 && sub.quality.length > 0) {
    const srcSet = new Set(src.quality);
    const subSet = new Set(sub.quality);
    const intersection = [...srcSet].filter(x => subSet.has(x));
    if (srcSet.size === subSet.size && intersection.length === srcSet.size) {
      totalPoints += 25;
    } else if (intersection.length > 0) {
      totalPoints += (intersection.length / Math.max(srcSet.size, subSet.size)) * 20;
    }
  } else if (src.quality.length === 0 && sub.quality.length === 0) {
    totalPoints += 15;
  }

  // 3. Codec match (10 points)
  maxPoints += 10;
  if (src.codec.length > 0 && sub.codec.length > 0) {
    const srcSet = new Set(src.codec);
    const hasMatch = sub.codec.some(c => srcSet.has(c));
    if (hasMatch) totalPoints += 10;
  } else if (src.codec.length === 0 && sub.codec.length === 0) {
    totalPoints += 5;
  }

  // 4. Audio match (5 points)
  maxPoints += 5;
  if (src.audio.length > 0 && sub.audio.length > 0) {
    const srcSet = new Set(src.audio);
    const hasMatch = sub.audio.some(a => srcSet.has(a));
    if (hasMatch) totalPoints += 5;
  } else if (src.audio.length === 0 && sub.audio.length === 0) {
    totalPoints += 2;
  }

  // 5. Release group match (20 points)
  maxPoints += 20;
  if (src.group && sub.group) {
    if (src.group === sub.group) totalPoints += 20;
  } else if (!src.group && !sub.group) {
    totalPoints += 5;
  }

  // 6. Season/Episode match (10 points)
  if (src.seasonEpisode || sub.seasonEpisode) {
    maxPoints += 10;
    if (src.seasonEpisode && sub.seasonEpisode) {
      if (src.seasonEpisode === sub.seasonEpisode) totalPoints += 10;
      else totalPoints -= 10; // Very bad signal
    }
  }

  if (maxPoints === 0) return 0;
  return Math.max(0, Math.min(100, Math.round((totalPoints / maxPoints) * 100)));
}

/**
 * Match a source name against a list of subtitles.
 * Returns sorted matches above minScore.
 */
function matchSource(sourceName, subtitles, minScore = 40) {
  const matches = [];
  for (const sub of subtitles) {
    const score = computeMatchScore(sourceName, sub.name || '');
    if (score >= minScore) {
      matches.push({ ...sub, score });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return matches;
}

/**
 * Enrich a list of streams with subtitle match data.
 * Returns streams with added matchPct and bestMatch fields.
 */
function enrichStreams(streams, subtitles) {
  return streams.map(stream => {
    const matches = matchSource(stream.name || '', subtitles);
    if (matches.length > 0) {
      return {
        ...stream,
        matchPct: matches[0].score,
        bestMatch: matches[0],
        allMatches: matches,
      };
    }
    return { ...stream, matchPct: 0, bestMatch: null, allMatches: [] };
  });
}

module.exports = { normalize, extractComponents, computeMatchScore, matchSource, enrichStreams };
