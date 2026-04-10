# HebSubScout - Hebrew Subtitle Intelligence for Stremio

**See Hebrew subtitle match % on every source BEFORE you pick.** Auto-selects the best matching Hebrew subtitle on playback.

Free & open source alternative to "Heb Subs Premium".

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## What Makes This Different

Other Hebrew subtitle addons (ktuvit-stremio, wizdom-stremio) only provide subtitles **after** you start playing. You pick a source blind, hope it has matching Hebrew subs, and if it doesn't — you go back and try another.

**HebSubScout shows the match quality on every source before you choose:**

```
1080p AV1 BluRay | [עב 100%] | 3.2 GB 👤 16 | 1337x
1080p H.265 BluRay DD5.1 | [עב 61%] | 7.56 GB 👤 5 | TorrentGalaxy  
720p H.264 WEB-DL | [עב ✗] | 1.1 GB 👤 3 | RARBG
```

- `[עב 92%]` = Hebrew subtitle matches this source 92%
- `[עב ✗]` = No matching Hebrew subtitle found

## Quick Install

### Self-Hosted (Local)

```bash
git clone https://github.com/shahar015/hebsubscout-stremio.git
cd hebsubscout-stremio
npm install
npm start
```

Then add `http://localhost:7070/manifest.json` in Stremio or Nuvio.

### With Ktuvit Support (Optional)

```bash
KTUVIT_EMAIL=your@email.com KTUVIT_PASSWORD=sha256hash npm start
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 7070) |
| `KTUVIT_EMAIL` | No | Ktuvit.me login email |
| `KTUVIT_PASSWORD` | No | Ktuvit.me SHA-256 hashed password |
| `OPENSUBS_API_KEY` | No | OpenSubtitles API key |
| `MEDIAFUSION_URL` | No | MediaFusion encrypted config URL |
| `BASE_URL` | No | Public URL for hosted deployments |

## How It Works

1. When you browse a movie/show in Stremio, HebSubScout intercepts the stream request
2. It fetches sources from **Torrentio** (and optionally **MediaFusion**) in parallel with Hebrew subtitles from **Wizdom.xyz**, **Ktuvit.me**, and **OpenSubtitles**
3. Each source gets scored against available Hebrew subtitles using a fuzzy matching algorithm
4. Sources are returned with match % in the title — you see which one has the best Hebrew sub match
5. When you play, the best matching subtitle is auto-selected

### Matching Algorithm

Scores 0-100 based on release name similarity:

| Component | Points | Logic |
|-----------|--------|-------|
| Title | 30 | String similarity on normalized title tokens |
| Quality | 25 | Exact quality tag match (1080p, BluRay, etc.) |
| Release Group | 20 | Exact group match (-RARBG, -YTS, etc.) |
| Codec | 10 | Codec intersection (x265, H.264, etc.) |
| Season/Episode | 10 | Exact match for TV shows |
| Audio | 5 | Audio codec intersection (DTS, AAC, etc.) |

## Subtitle Providers

| Provider | Auth Required | Notes |
|----------|--------------|-------|
| **Wizdom.xyz** | None | Primary source, largest Hebrew subtitle database |
| **Ktuvit.me** | Email + Password | Downloads proxied through addon server |
| **OpenSubtitles** | API Key | Top 5 results (rate limited) |

## Source Providers

| Provider | Auth Required | Notes |
|----------|--------------|-------|
| **Torrentio** | None | Default source scraper |
| **MediaFusion** | Config URL | Optional, requires encrypted config URL with RD token |

## Works With

- **Stremio** (desktop, mobile, TV)
- **Nuvio** (React Native app that wraps Stremio addons)

## Community

Built for the Israeli streaming community (kodi7rd / RD Israel). This is a free, open-source alternative to paid subtitle matching services.

## License

MIT
