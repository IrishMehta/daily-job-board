# Development and data contracts

Reviewed 2026-11-15. `README.md` is a generated, dated job listing; normal dataset
publication replaces it. This guide describes the hand-maintained frontend and API.

## Frontend

The site in `docs/` is zero-build HTML, CSS, and ES modules. Serve it through HTTP
from this repository root using a suitable Python environment:

```bash
python -m http.server 8765 --bind 127.0.0.1 --directory docs
```

Open `http://127.0.0.1:8765/`; `/?view=market` opens Market trends. The site needs
HTTP for module, worker, and data loading. Use a fresh browser profile when reviewing
changed JavaScript/CSS to avoid stale cached assets.

Advanced lexical search runs in `docs/search-worker.js`, with policy in
`docs/search-config.json` and a basic-search fallback. Facet counts respond to the
current selection. Match Resume is retired.
The frontend does not load embedding files or a resume model.
The UI uses role summaries instead of full-description shards.

The build pipeline supplies `docs/data/public_jobs.json`, hiring posts, branding/assets,
and aggregate `market_analysis.json`. Keep hand edits out of
generated data; fix the producer or source policy instead. Market views use aggregate
cohort/filter-slice data, including filtered localities, rather than inferring trends
from the currently visible job rows.

Run frontend contracts from this directory:

```bash
python -m unittest tests.test_frontend_contract tests.test_taxonomy_navigation \
  tests.test_advanced_search_contract
```

Browser harnesses are `tests/search_unit_tests.html` and `tests/search_performance.html`.
The Python contracts check static wiring and policy; they do not replace interactive
browser review. The public dataset contains up to 25 days of jobs.
The previous 30 MB payload budget is removed.
Review keyboard navigation, narrow screens, and empty/error states after UI changes.

## API and publication

The canonical public jobs JSON is served by GitHub Pages and copied into Cloudflare D1
for the read-only Worker API. The dataset-sync workflow is triggered by changes to that
JSON or its workflow, or by manual dispatch. It tests the Worker/importer, applies
migrations, builds and applies validated incremental SQL, then verifies live version/count.
The frontend, Hiring Posts, and Market trends remain distinct from the `/v1/jobs` dataset.

Use [the API guide](services/job-api/README.md) for local database setup and tests, and
follow [API agent instructions](services/job-api/AGENTS.md) when changing Worker/D1 code.
Local tests must not target the remote database. Source jobs can close after publication;
verify the employer posting before applying.
