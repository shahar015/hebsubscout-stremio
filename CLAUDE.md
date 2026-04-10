# CLAUDE.md — HebSubScout Stremio Addon

## Project Overview

Stremio/Nuvio addon that provides **Hebrew subtitle intelligence** — shows match % on every source BEFORE the user picks, and auto-selects the best matching Hebrew subtitle on playback. Free & open source alternative to "Heb Subs Premium" (paid).

**Status:** v2.0.0 — own torrent pipeline with Real-Debrid, deployed on Render.

**Live:** https://hebsubscout-stremio.onrender.com

## How It Works

1. User configures RD token + optional subtitle providers on configure page
2. Gets a unique install URL with config encoded in path (base64url)
3. **Stream handler:** Searches YTS/EZTV for torrents → checks RD instant availability → resolves cached to direct HTTP links → enriches with `[עב XX%]`
4. **Subtitle handler:** Returns Hebrew subtitles from Wizdom/Ktuvit/OpenSubs sorted by match quality (best first = auto-selected)

## Architecture

```
hebsubscout-stremio/
├── index.js           # Entry point — manifest, handlers, HTTP server with proxy + config URLs
├── configure.html     # Web installer page (Hebrew UI, 3-step setup)
├── lib/
│   ├── matcher.js     # Fuzzy matching algorithm: title(30) + quality(25) + group(20) + codec(10) + S/E(10) + audio(5)
│   ├── providers.js   # Hebrew subtitle providers: Wizdom.xyz, Ktuvit.me, OpenSubtitles
│   ├── indexers.js    # Torrent indexers: YTS (movies) + EZTV (TV) — search by IMDB ID
│   ├── realdebrid.js  # RD API: instant availability, torrent resolve, unrestrict links
│   ├── scrapers.js    # Legacy Torrentio scraper (kept for self-hosted use)
│   └── cache.js       # In-memory TTL cache
├── Dockerfile
├── render.yaml
├── package.json
└── .gitignore
```

## Commands

```bash
npm install          # Install dependencies
npm start            # Start addon server on port 7070
npm run dev          # Start with --watch (auto-restart on changes)
```

## Configuration (Environment Variables)

```bash
PORT=7070                     # Server port (default 7070)
KTUVIT_EMAIL=user@example.com # Optional: Ktuvit.me login
KTUVIT_PASSWORD=sha256hash    # Optional: Ktuvit.me hashed password
OPENSUBS_API_KEY=your_key     # Optional: OpenSubtitles API key
MEDIAFUSION_URL=https://...   # Optional: MediaFusion encrypted config URL
```

## Key APIs

| Provider | Endpoint | Auth |
|----------|----------|------|
| Wizdom.xyz | `GET /api/search?action=by_id&imdb={id}` | None |
| Ktuvit.me | POST login → POST search → GET HTML parse | Cookie session |
| OpenSubtitles | `GET /api/v1/subtitles?imdb_id={id}&languages=he` | API key header |
| Torrentio | `GET /stream/{type}/{id}.json` | None |
| MediaFusion | `GET {configUrl}/stream/{type}/{id}.json` | Encrypted URL |

## Matching Algorithm (The Secret Sauce)

Scores 0-100 how well a subtitle name matches a source name:

| Component | Points | Logic |
|-----------|--------|-------|
| Title | 30 | String similarity ratio on normalized title tokens |
| Quality | 25 | Exact set match = 25, partial = proportional |
| Release Group | 20 | Exact match = 20, different = 0 |
| Codec | 10 | Any intersection = 10 |
| Season/Episode | 10 | Exact = 10, mismatch = -10 |
| Audio | 5 | Any intersection = 5 |

Quick checks: exact normalized = 100, contains = 95.

## Stream Title Format

```
With match:     "1080p BluRay H.265 | [עב 92%] | Torrentio | 4.2 GB"
No match found: "1080p BluRay H.265 | [עב ✗] | Torrentio | 4.2 GB"
No subs checked:"1080p BluRay H.265 | Torrentio | 4.2 GB"
```

## Context: Israeli Streaming Ecosystem

- Community (kodi7rd / RD Israel) migrated: **Kodi → Stremio → Nuvio**
- **Nuvio** (by tapframe) is a React Native app that wraps Stremio addons + adds profiles
- Our Stremio addon works with BOTH Stremio and Nuvio
- "Heb Subs Premium" is a paid addon doing similar subtitle matching — we're the free alternative
- Existing free addons (ktuvit-stremio, wizdom-stremio) only provide subtitles post-playback, no pre-selection matching

## Deployment Options

1. **Local:** `node index.js` → `http://localhost:7070/manifest.json`
2. **Hosted:** Deploy to Render/Railway/Vercel → public URL
3. **Docker:** Standard Node.js Dockerfile

## Gotchas

- Ktuvit HTML parsing is fragile — if they change layout, parsing breaks
- Wizdom fallback endpoint uses nested `subs[season][episode]` for TV shows
- MediaFusion requires per-user encrypted config URL (embeds RD token)
- `node-fetch` v2 used (CommonJS compatible) — v3 is ESM-only
- `string-similarity` package is deprecated but works fine — consider `fastest-levenshtein` if needed
- `npm install` shows deprecation warnings for string-similarity — harmless, works fine
- If upgrading to Node 18+, can remove `node-fetch` dependency (built-in fetch available)

## Roadmap

1. **Testing & Polish** — live test with real content, fix edge cases
2. **GitHub repo** — publish for community
3. **Hosted deployment** — public URL so users don't need to self-host
4. **Web installer page** — like stremio7rd-build-installer.vercel.app but with HebSubScout
5. **Play Store app** — fork Nuvio with addon baked in, profiles, Hebrew-first UI

## Parent Project

The Kodi addon lives at: `C:\Users\shaha\Desktop\Projects\hebsubscout`
The matching algorithm was ported from: `script.module.hebsubscout/lib/hebsubscout/matcher.py`
