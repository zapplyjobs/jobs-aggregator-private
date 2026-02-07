# jobs-data-2026

**Status:** ✅ Aggregator - COMPLETE & VERIFIED (Phases 0-3) - **2026-02-07**

## Purpose

Central Discord posting aggregator for all job board repositories. This repo reads `current_jobs.json` from individual repos and posts to Discord with global deduplication.

## Architecture

```
Individual Repos (FETCHING LAYER)          Aggregator (POSTING LAYER)
┌─────────────────────────────┐           ┌──────────────────────────────┐
│ New-Grad-Jobs-2026          │──────────▶│                                  │
│ Internships-2026            │──────────▶│  Read current_jobs.json        │
│ (SEO repos - Phase 4)       │──────────▶│  Global deduplication (14d)    │
└─────────────────────────────┘           │  Post to Discord               │
                                          └──────────────────────────────┘
```

- **Individual repos** fetch jobs (JSearch, ATS, SimplifyJobs) → write `current_jobs.json`
- **Aggregator** reads all → deduplicates globally → posts to Discord
- This is the INTENDED design - separation of concerns

## Workflows

| Workflow | Schedule | Purpose |
|----------|----------|---------|
| `post-to-discord.yml` | Every 5 min | Fetch & post jobs to Discord |
| `verify-discord.yml` | Daily / manual | Verify posting correctness |
| `health-check.yml` | Every hour | System health monitoring |
| `collect-metrics.yml` | Daily | Operational metrics |

## Features

- ✅ Global deduplication (14-day TTL)
- ✅ Industry + location channel routing
- ✅ Discord embed formatting (emojis, tags, counter)
- ✅ Verification tool (privacy-encrypted reports)
- ✅ Health monitoring

## Phase Status

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 0 | Monitoring workflows | ✅ Complete |
| Phase 1 | Removed Discord from individual repos | ✅ Complete |
| Phase 2 | Aggregator Discord posting | ✅ Complete |
| Phase 3 | Global deduplication | ✅ Complete |
| Phase 4 | Enable SEO repos (5 repos) | ⏳ Ready |
| Phase 5 | Verification & testing | ✅ Complete |

## Files

- `.github/scripts/discord-poster.js` - Main posting logic
- `.github/scripts/verify-discord.js` - Discord verification tool
- `.github/scripts/companies.json` - Company emoji/tier data
- `global-dedupe-store.json` - Persistent dedupe database (auto-generated)

## Configuration

All secrets configured:
- `DISCORD_TOKEN` - Bot authentication
- 15x `DISCORD_*_CHANNEL_ID` - Industry + location channels
- `JSEARCH_API_KEY` - JSearch API access

---

**Last Updated:** 2026-02-07
