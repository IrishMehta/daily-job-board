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

## Build a dataset import

From this directory, validate the published payload and generate a staged load
plus a separately guarded activation:

```sh
npm run db:build-import
```

This writes `generated/load.sql`, `generated/activate.sql`, and
`generated/import-manifest.json`. Generated files are intentionally ignored.
Loading does not change the API's active dataset. The activation statement only
switches the singleton pointer when all expected job, classification, and
specialization rows are present.

Exercise the complete process against local D1 with:

```sh
npm run db:migrate:local
npm run db:build-import
npm run db:load:local
npm run db:activate:local
```

The equivalent `db:load:remote` and `db:activate:remote` commands are deliberately
separate. Production activation should run only after the staged counts have
been checked.

## Read API

The Worker exposes a read-only v1 interface:

```text
GET /v1/status
GET /v1/jobs
GET /v1/jobs/{url-encoded-job-id}
GET /v1/facets
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
