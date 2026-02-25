# jobs-aggregator-private

Automated job aggregation pipeline for [Zapply](https://zapply.jobs). Runs every 15 minutes, aggregates entry-level and new-grad positions from multiple sources, and publishes a unified feed used by the job boards.

## What it does

- Fetches new-grad and entry-level jobs from multiple sources
- Filters, tags, and deduplicates across sources
- Publishes `all_jobs.json` to [jobs-data-2026](https://github.com/zapplyjobs/jobs-data-2026) after each run

## Related repositories

- [New-Grad-Jobs-2026](https://github.com/zapplyjobs/New-Grad-Jobs-2026) — entry-level jobs board
- [Internships-2026](https://github.com/zapplyjobs/Internships-2026) — internships board
- [New-Grad-Software-Engineering-Jobs-2026](https://github.com/zapplyjobs/New-Grad-Software-Engineering-Jobs-2026)
- [New-Grad-Data-Science-Jobs-2026](https://github.com/zapplyjobs/New-Grad-Data-Science-Jobs-2026)
- [New-Grad-Hardware-Engineering-Jobs-2026](https://github.com/zapplyjobs/New-Grad-Hardware-Engineering-Jobs-2026)
- [New-Grad-Nursing-Jobs-2026](https://github.com/zapplyjobs/New-Grad-Nursing-Jobs-2026)
