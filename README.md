# jobs-data-2026

**Central Jobs Fetcher** - Aggregates job listings from JSearch API and distributes them to consumer repositories.

## Purpose

This repository serves as the single source of truth for job data across all Zapply job boards:
- Internships-2026
- New-Grad-Jobs-2026
- Remote-Jobs-2026

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    jobs-data-2026                           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   JSearch    │───▶│  Normalizer  │───▶│ Deduplicator │  │
│  │   API        │    │              │    │              │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│                                                     │         │
│                                                     ▼         │
│                                          ┌─────────────────┐  │
│                                          │ jobs-shared.json │  │
│                                          │   (JSONL format)  │  │
│                                          └────────┬──────────┘  │
└───────────────────────────────────────────┼──────────────────┘
                                                 │ Git Push
                                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Consumer Repositories                        │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐│
│  │ Internships-2026 │  │ New-Grad-2026    │  │ Remote-2026     ││
│  │ (git submodule)  │  │ (git submodule)  │  │ (git submodule) ││
│  └──────────────────┘  └──────────────────┘  └──────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Data Sources

| Source | Type | Status |
|--------|------|--------|
| JSearch API | Paid ($25/month, 10K requests) | ✅ Active |
| ATS APIs (Greenhouse/Lever/Ashby) | Free | 🔄 Coming soon |
| USAJobs API | Free | 🔄 Coming soon |

## Output Format

### `jobs-shared.json` (JSONL - one JSON object per line)

```json
{"id":"js-google-12345","title":"Software Engineer Intern","company":"Google","location":"Mountain View, CA","remote":false,"url":"https://...","posted_at":"2026-02-03T10:00:00Z","source":"jsearch","employment_types":["INTERN"],"experience_level":"entry","description":null,"enriched":false,"is_internship":true,"is_new_grad":false,"is_remote":false,"is_us_only":true,"fingerprint":"sha256-abc123..."}
```

### Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique ID: `{source_prefix}-{company_slug}-{job_id}` |
| `fingerprint` | string | SHA-256 hash for deduplication |
| `title` | string | Job title |
| `company` | string | Company name |
| `location` | string | Human-readable location |
| `remote` | boolean | Remote position |
| `url` | string | Application URL |
| `posted_at` | string | ISO 8601 datetime |
| `source` | string | Data source (`jsearch`, `greenhouse`, etc.) |
| `employment_types` | array | `['INTERN']`, `['FULLTIME']`, etc. |
| `experience_level` | string | `entry`, `mid`, `senior` |
| `description` | string\|null | Job description (null if not fetched) |
| `enriched` | boolean | Whether description has been fetched |
| `is_internship` | boolean | Pre-computed filter hint |
| `is_new_grad` | boolean | Pre-computed filter hint |
| `is_remote` | boolean | Pre-computed filter hint |
| `is_us_only` | boolean | Pre-computed filter hint |

## Workflow Schedule

- **Frequency**: Every 15 minutes
- **Schedule**: `*/15 * * * *`
- **Location**: `.github/workflows/fetch-jobs.yml`

## Consumer Integration

### As Git Submodule (Recommended)

```bash
# In consumer repo
git submodule add https://github.com/zapplyjobs/jobs-data-2026.git .github/shared-data
```

### Consumer Workflow

```yaml
# In consumer repo's update-jobs.yml
- name: Update shared data
  run: |
    cd .github/shared-data
    git pull origin main

- name: Filter for [internships | new grad | remote]
  run: node .github/scripts/filter-shared-jobs.js
```

## JSearch API Configuration

| Setting | Value |
|---------|-------|
| Plan | Pro ($25/month) |
| Requests/month | 10,000 |
| Requests/day | ~333 |
| Queries per run | 1 |
| Pages per query | 10 (up to 100 jobs) |
| Estimated jobs/run | ~50-100 |

## Query Rotation

Queries rotate based on current hour to distribute coverage:

```javascript
const QUERIES = [
  'software engineer intern',        // Hour 0, 5, 10, 15, 20...
  'software engineering internship', // Hour 1, 6, 11, 16, 21...
  'data science intern',             // Hour 2, 7, 12, 17, 22...
  'machine learning intern',         // Hour 3, 8, 13, 18, 23...
  'product manager intern'           // Hour 4, 9, 14, 19, 24...
];
```

## Maintenance

### Monitoring

Check workflow status:
```bash
gh workflow list --repo zapplyjobs/jobs-data-2026
```

View latest run:
```bash
gh workflow view --repo zapplyjobs/jobs-data-2026
```

### Troubleshooting

**Problem**: Jobs not updating in consumer repos
- **Solution**: Check git submodule is up to date (`cd .github/shared-data && git status`)

**Problem**: Duplicate jobs appearing
- **Solution**: Check fingerprint generation in deduplicator.js

**Problem**: Workflow failing
- **Solution**: Check Actions tab for error logs

## Development

### Local Testing

```bash
npm install
npm test  # Dry run with verbose output
```

### Adding New Data Sources

1. Create fetcher in `.github/scripts/fetchers/`
2. Add to orchestrator in `.github/scripts/index.js`
3. Update README.md with source details

## License

MIT

## Contact

- GitHub: https://github.com/zapplyjobs/jobs-data-2026
- Issues: https://github.com/zapplyjobs/jobs-data-2026/issues
