import { documentResponse, jsonResponse } from "./http";

function apiOrigin(request: Request): string {
	return new URL(request.url).origin;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function sevenDaysAgo(): string {
	return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function openApiHandler(request: Request): Response {
	const origin = apiOrigin(request);
	const filterParameters = [
		["q", "Keyword search across titles, companies, summaries, and taxonomy terms."],
		["career_bucket", "Exact career bucket value returned by /v1/facets."],
		["experience_level", "Exact experience level value returned by /v1/facets."],
		["authorization_category", "Exact work-authorization category."],
		["sponsorship_status", "Exact sponsorship status."],
		["company", "Exact company name, matched case-insensitively."],
		["state", "Two-letter US region code, such as AZ or CA."],
		["domain", "Exact taxonomy domain returned by /v1/facets."],
		["specialization", "Exact taxonomy specialization returned by /v1/facets."],
		["industry", "Exact taxonomy industry returned by /v1/facets."],
	] as const;

	const jobProperties = {
		id: { type: "string", format: "uri" },
		posted_on: { type: "string", format: "date" },
		company: { type: "string" },
		title: { type: "string" },
		location: { type: "string" },
		location_profile: { type: "object", additionalProperties: true },
		career_bucket: { type: "string" },
		career_bucket_label: { type: "string" },
		experience_level: { type: "string" },
		experience_level_label: { type: "string" },
		yoe_min: { type: ["number", "null"] },
		yoe_max: { type: ["number", "null"] },
		experience_display: { type: "string" },
		authorization_category: { type: "string" },
		authorization_category_label: { type: "string" },
		sponsorship_status: { type: "string" },
		work_authorization_display: { type: "string" },
		classification_paths: {
			type: "array",
			items: { type: "object", additionalProperties: true },
		},
		summary: { type: "string" },
		description_excerpt: { type: "string" },
		job_link: { type: "string", format: "uri" },
	};

	return jsonResponse(
		{
			openapi: "3.1.0",
			info: {
				title: "Irish Mehta Public Job API",
				version: "1.0.0",
				description:
					"Read-only search over public US job postings. No authentication is required.",
			},
			servers: [{ url: origin }],
			paths: {
				"/v1/status": {
					get: {
						operationId: "getDatasetStatus",
						summary: "Check API readiness and dataset freshness",
						responses: {
							"200": {
								description: "Current dataset status",
								content: {
									"application/json": {
										schema: { $ref: "#/components/schemas/StatusResponse" },
									},
								},
							},
						},
					},
				},
				"/v1/jobs": {
					get: {
						operationId: "searchJobs",
						summary: "Search public jobs with combinable filters",
						description:
							"Use /v1/facets to discover exact taxonomy values. Reuse all filters when following next_cursor.",
						parameters: [
							...filterParameters.map(([name, description]) => ({
								name,
								in: "query",
								required: false,
								description,
								schema: { type: "string", maxLength: 100 },
							})),
							{
								name: "posted_since",
								in: "query",
								required: false,
								description: "Inclusive earliest posting date in YYYY-MM-DD format.",
								schema: { type: "string", format: "date" },
							},
							{
								name: "limit",
								in: "query",
								required: false,
								description: "Jobs per response. Defaults to 20; maximum 50.",
								schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
							},
							{
								name: "cursor",
								in: "query",
								required: false,
								description:
									"Opaque next_cursor from the previous response. Keep all other filters unchanged.",
								schema: { type: "string" },
							},
						],
						responses: {
							"200": {
								description: "A page of matching jobs",
								content: {
									"application/json": {
										schema: { $ref: "#/components/schemas/JobSearchResponse" },
									},
								},
							},
							"400": { $ref: "#/components/responses/BadRequest" },
							"503": { $ref: "#/components/responses/DatasetUnavailable" },
						},
					},
				},
				"/v1/jobs/{job_id}": {
					get: {
						operationId: "getJob",
						summary: "Get one job by its stable ID",
						parameters: [
							{
								name: "job_id",
								in: "path",
								required: true,
								description: "The complete job ID URL encoded as one path segment.",
								schema: { type: "string" },
							},
						],
						responses: {
							"200": {
								description: "Job details",
								content: {
									"application/json": {
										schema: { $ref: "#/components/schemas/JobDetailResponse" },
									},
								},
							},
							"404": { $ref: "#/components/responses/NotFound" },
						},
					},
				},
				"/v1/facets": {
					get: {
						operationId: "listJobFacets",
						summary: "List valid filter values and current counts",
						responses: {
							"200": {
								description: "Current filter values",
								content: {
									"application/json": {
										schema: { type: "object", additionalProperties: true },
									},
								},
							},
						},
					},
				},
			},
			components: {
				schemas: {
					Job: {
						type: "object",
						required: ["id", "posted_on", "company", "title", "job_link"],
						properties: jobProperties,
					},
					JobSearchResponse: {
						type: "object",
						required: ["data", "pagination", "meta"],
						properties: {
							data: { type: "array", items: { $ref: "#/components/schemas/Job" } },
							pagination: {
								type: "object",
								properties: {
									limit: { type: "integer" },
									returned: { type: "integer" },
									next_cursor: { type: ["string", "null"] },
								},
							},
							meta: { type: "object", additionalProperties: true },
						},
					},
					JobDetailResponse: {
						type: "object",
						properties: {
							data: { $ref: "#/components/schemas/Job" },
							meta: { type: "object", additionalProperties: true },
						},
					},
					StatusResponse: { type: "object", additionalProperties: true },
					ErrorResponse: {
						type: "object",
						properties: {
							error: {
								type: "object",
								properties: {
									code: { type: "string" },
									message: { type: "string" },
									parameter: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					BadRequest: {
						description: "Invalid or unsupported parameter",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/ErrorResponse" },
							},
						},
					},
					NotFound: {
						description: "Job not found",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/ErrorResponse" },
							},
						},
					},
					DatasetUnavailable: {
						description: "No validated dataset is active",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/ErrorResponse" },
							},
						},
					},
				},
			},
		},
		200,
		"public, max-age=300",
	);
}

export function llmsTxtHandler(request: Request): Response {
	const origin = apiOrigin(request);
	const postedSinceExample = sevenDaysAgo();
	return documentResponse(
		`# Irish Mehta Public Job API

> Read-only search over public US job postings. No authentication is required.

Base URL: ${origin}
Human documentation: ${origin}/docs
OpenAPI contract: ${origin}/openapi.json

## Recommended workflow

1. GET ${origin}/v1/status to verify that the dataset is ready and inspect its timestamp.
2. GET ${origin}/v1/facets to discover current exact values for domains, specializations, career buckets, states, authorization categories, and other filters.
3. GET ${origin}/v1/jobs with only the filters needed for the user's request.
4. If pagination.next_cursor is not null and more results are needed, repeat the same request with cursor set to that value. Keep every other filter unchanged.
5. Present job_link as the application link. Do not invent jobs or filter values.

## Search endpoint

GET ${origin}/v1/jobs

Combinable query parameters:
q, career_bucket, experience_level, authorization_category, sponsorship_status,
company, state, domain, specialization, industry, posted_since, limit, cursor

Rules:
- posted_since uses YYYY-MM-DD and is inclusive.
- state uses a two-letter code such as AZ or CA.
- limit defaults to 20 and cannot exceed 50.
- Exact taxonomy values should come from /v1/facets.
- Results are ordered by posted_on descending, then stable job ID.

Example: early-career ML engineering jobs in Arizona
${origin}/v1/jobs?career_bucket=early_career_or_new_grad&domain=ai_machine_learning&specialization=machine_learning&state=AZ&limit=10

Example: recent data-science jobs
${origin}/v1/jobs?specialization=data_science&posted_since=${postedSinceExample}&limit=10

## Job details

GET ${origin}/v1/jobs/{url-encoded-job-id}

The job ID is generally a URL and must be encoded as one path segment.

## Access note

A browsing-enabled assistant may retrieve these public URLs when its interface permits web access. Pasting this documentation link does not install the API as a native tool and does not guarantee that every chat interface will make external requests.
`,
		"text/plain; charset=utf-8",
	);
}

export function docsHandler(request: Request): Response {
	const origin = apiOrigin(request);
	const postedSinceExample = sevenDaysAgo();
	const safeOrigin = escapeHtml(origin);
	const example = `${origin}/v1/jobs?career_bucket=early_career_or_new_grad&domain=ai_machine_learning&specialization=machine_learning&state=AZ&limit=10`;
	const safeExample = escapeHtml(example);
	return documentResponse(
		`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Documentation for the Irish Mehta Public Job API">
  <title>Public Job API</title>
  <style>
    :root { color-scheme: light; --ink:#142019; --muted:#607067; --line:#d9ded9; --paper:#f7f6f0; --panel:#fff; --accent:#5f7f18; --dark:#101a14; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--paper); color:var(--ink); font:16px/1.6 Inter, ui-sans-serif, system-ui, sans-serif; }
    header { background:var(--dark); color:#f4f7f2; border-bottom:3px solid #b7ed43; }
    nav, main { width:min(1100px, calc(100% - 32px)); margin:auto; }
    nav { min-height:64px; display:flex; align-items:center; justify-content:space-between; gap:20px; }
    nav strong { letter-spacing:.02em; } nav a { color:#dce8dc; text-decoration:none; margin-left:18px; }
    main { padding:52px 0 80px; }
    .eyebrow { color:var(--accent); font:700 12px/1.2 ui-monospace, monospace; letter-spacing:.12em; text-transform:uppercase; }
    h1 { max-width:760px; margin:10px 0 14px; font-size:clamp(38px, 6vw, 68px); line-height:1; letter-spacing:-.045em; }
    h2 { margin:0 0 12px; font-size:24px; } h3 { margin:0 0 8px; }
    .lead { max-width:760px; color:var(--muted); font-size:19px; }
    .grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; margin:36px 0; }
    .card, section { background:var(--panel); border:1px solid var(--line); }
    .card { padding:22px; } .step { color:var(--accent); font:700 12px ui-monospace, monospace; }
    section { margin-top:18px; padding:28px; }
    code, pre { font-family:"SFMono-Regular", Consolas, monospace; }
    code { font-size:.9em; } pre { overflow:auto; background:#111a15; color:#e7eee6; padding:18px; border-radius:3px; font-size:13px; }
    table { width:100%; border-collapse:collapse; } th, td { padding:11px 8px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; } th { font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .links a { color:#345900; font-weight:650; } .note { border-left:4px solid #b7ed43; padding-left:16px; color:var(--muted); }
    @media (max-width:760px) { .grid { grid-template-columns:1fr; } nav span { display:none; } main { padding-top:36px; } section { padding:20px; } table { display:block; overflow:auto; } }
  </style>
</head>
<body>
  <header><nav><strong>Public Job API</strong><span><a href="${safeOrigin}/v1/status">Status</a><a href="${safeOrigin}/openapi.json">OpenAPI</a><a href="${safeOrigin}/llms.txt">LLM guide</a></span></nav></header>
  <main>
    <div class="eyebrow">Read-only · public · no authentication</div>
    <h1>Search the public job board programmatically.</h1>
    <p class="lead">This API exposes current US job postings with combined filters for career level, taxonomy, location, work authorization, company, date, and keywords.</p>

    <div class="grid">
      <article class="card"><div class="step">01 · CHECK</div><h3>Verify freshness</h3><p>Call <code>/v1/status</code> to confirm a validated dataset is active.</p></article>
      <article class="card"><div class="step">02 · DISCOVER</div><h3>Read valid values</h3><p>Call <code>/v1/facets</code> before choosing domains or specializations.</p></article>
      <article class="card"><div class="step">03 · SEARCH</div><h3>Combine filters</h3><p>Call <code>/v1/jobs</code> and follow <code>next_cursor</code> only if needed.</p></article>
    </div>

    <section>
      <h2>Quick example</h2>
      <p>Early-career ML engineering jobs in Arizona:</p>
      <pre>GET ${safeExample}</pre>
      <p class="links"><a href="${safeExample}">Run this request →</a></p>
    </section>

    <section>
      <h2>Endpoints</h2>
      <table><thead><tr><th>Endpoint</th><th>Purpose</th></tr></thead><tbody>
        <tr><td><code>GET /v1/status</code></td><td>Dataset readiness, version, timestamps, and job count.</td></tr>
        <tr><td><code>GET /v1/facets</code></td><td>Valid filter values with counts from the active dataset.</td></tr>
        <tr><td><code>GET /v1/jobs</code></td><td>Combined job search with bounded cursor pagination.</td></tr>
        <tr><td><code>GET /v1/jobs/{job_id}</code></td><td>One job; encode its URL-shaped ID as one path segment.</td></tr>
      </tbody></table>
    </section>

    <section>
      <h2>Search filters</h2>
      <table><thead><tr><th>Parameter</th><th>Meaning</th><th>Example</th></tr></thead><tbody>
        <tr><td><code>q</code></td><td>Keyword search across public searchable text.</td><td><code>q=production+ml</code></td></tr>
        <tr><td><code>career_bucket</code></td><td>Career grouping from facets.</td><td><code>early_career_or_new_grad</code></td></tr>
        <tr><td><code>domain</code></td><td>Broad role taxonomy domain.</td><td><code>ai_machine_learning</code></td></tr>
        <tr><td><code>specialization</code></td><td>Role specialization within a taxonomy path.</td><td><code>machine_learning</code></td></tr>
        <tr><td><code>industry</code></td><td>Industry classification from facets.</td><td><code>technology_software</code></td></tr>
        <tr><td><code>state</code></td><td>Two-letter US region code.</td><td><code>AZ</code></td></tr>
        <tr><td><code>experience_level</code></td><td>Experience inference from facets.</td><td><code>entry_level_or_new_grad</code></td></tr>
        <tr><td><code>authorization_category</code></td><td>Work-authorization classification.</td><td>Use facets</td></tr>
        <tr><td><code>sponsorship_status</code></td><td>Sponsorship signal.</td><td>Use facets</td></tr>
        <tr><td><code>company</code></td><td>Exact company name, case-insensitive.</td><td>Use facets</td></tr>
        <tr><td><code>posted_since</code></td><td>Inclusive earliest date.</td><td><code>${postedSinceExample}</code></td></tr>
        <tr><td><code>limit</code></td><td>1–50 jobs; defaults to 20.</td><td><code>10</code></td></tr>
        <tr><td><code>cursor</code></td><td>Opaque continuation value from <code>next_cursor</code>.</td><td>Reuse unchanged filters</td></tr>
      </tbody></table>
    </section>

    <section>
      <h2>Response shape</h2>
      <pre>{
  "data": [{ "title": "…", "company": "…", "job_link": "https://…" }],
  "pagination": { "limit": 20, "returned": 20, "next_cursor": "…" },
  "meta": { "dataset_version": "…", "dataset_generated_at": "…", "filters_applied": {} }
}</pre>
      <p>Use <code>job_link</code> as the application URL. Results are ordered by posting date descending and stable job ID.</p>
    </section>

    <section>
      <h2>Using this with an AI assistant</h2>
      <p>Give a browsing-enabled assistant this documentation URL and describe the filters you want. The assistant can inspect <code>/v1/facets</code> and request matching jobs when its interface permits external web access.</p>
      <p class="note">Pasting this page does not install the API as a native tool, and some chat interfaces may not retrieve external URLs. The machine-readable guides are <a href="${safeOrigin}/openapi.json">OpenAPI</a> and <a href="${safeOrigin}/llms.txt">llms.txt</a>.</p>
    </section>
  </main>
</body>
</html>`,
		"text/html; charset=utf-8",
	);
}
