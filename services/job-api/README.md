# Public job API

Cloudflare Worker and D1-backed read API for the already-public job board data.
The canonical source remains `docs/data/public_jobs.json`.

## Database environments

Local development uses Wrangler's local D1 database. Apply migrations with:

```sh
npm run db:migrate:local
```

Production migrations are always explicit:

```sh
npm run db:migrate:remote
```

The Worker accesses the database through the `DB` binding in `wrangler.jsonc`.
Never use `--remote` for routine local development or tests.

## Build an incremental dataset sync

From this directory, validate the published payload and generate a transactional
incremental sync:

```sh
npm run db:build-sync
```

This writes `generated/sync.sql` and `generated/import-manifest.json`. Generated
files are intentionally ignored. The sync uses stable job IDs: it upserts new or
changed jobs, deletes jobs absent from the source payload, and rebuilds normalized
classification rows only for changed jobs. It runs in one transaction, so readers
see either the old board or the completed update.

Exercise the complete process against local D1 with:

```sh
npm run db:migrate:local
npm run db:build-sync
npm run db:sync:local
```

The equivalent production command is `npm run db:sync:remote`. Apply migrations
explicitly before the first remote incremental sync.

## Read API

The Worker exposes a read-only v1 interface:

```text
GET /v1/status
GET /v1/jobs
GET /v1/jobs/{url-encoded-job-id}
GET /v1/facets
GET /docs
GET /openapi.json
GET /llms.txt
```

`GET /v1/jobs` supports these optional filters in any combination:

```text
q
career_bucket
experience_level
authorization_category
sponsorship_status
company
state
domain
specialization
industry
posted_since
limit
cursor
```

Results are ordered by posting date descending and then stable job ID. `limit`
defaults to 20 and is capped at 50. When more results exist, the response
includes an opaque `next_cursor`; callers should reuse it with the same filters.

Run the Worker checks without entering Vitest watch mode:

```sh
npm run typecheck
npm run test:run
```

The documentation routes are dataset-independent, so setup guidance remains
available even before the first validated production import is activated.
After deployment, the public entry points are:

- `https://job-api.irishmehta.workers.dev/docs` for people
- `https://job-api.irishmehta.workers.dev/openapi.json` for API clients
- `https://job-api.irishmehta.workers.dev/llms.txt` for browsing-enabled assistants
