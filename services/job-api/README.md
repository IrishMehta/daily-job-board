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
