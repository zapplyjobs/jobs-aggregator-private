# jobs-data-2026

⚠️ **DEPRECATED - 2026-02-06**

This repository is no longer actively maintained. The aggregator approach has been abandoned in favor of individual JSearch integration per job board repository.

## Rationale

The aggregator architecture introduced unnecessary complexity and single-point-of-failure risk. Each job board now independently fetches from its data sources (JSearch, ATS APIs, SimplifyJobs).

**Benefits of independence:**
- Each repo can fail without affecting others
- Custom queries, filters, schedules per repo
- Simpler testing and debugging
- No data freshness lag
- No deployment coordination needed

## Migration

All consuming repositories have been updated to set `USE_AGGREGATOR: 'false'` and now fetch data independently.

## Legacy Information

This repository previously provided job data in a standardized format for consumption by other repositories.

---

## License

MIT
