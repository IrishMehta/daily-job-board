import { ApiError, jsonResponse } from "./http";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_FILTER_LENGTH = 100;
const MAX_JOB_ID_LENGTH = 2048;

const ALLOWED_JOB_PARAMETERS = new Set([
	"authorization_category",
	"career_bucket",
	"company",
	"cursor",
	"domain",
	"experience_level",
	"industry",
	"limit",
	"posted_since",
	"q",
	"specialization",
	"sponsorship_status",
	"state",
]);

interface ActiveDatasetRow {
	version: string;
	source_schema_version: string;
	taxonomy_version: string;
	generated_at: string;
	imported_at: string;
	total_openings: number;
	posted_within_days: number;
	taxonomy_json: string;
	career_buckets_json: string;
	authorization_categories_json: string;
	sponsorship_statuses_json: string;
	activated_at: string;
}

interface JobRow {
	job_id: string;
	posted_on: string;
	company: string;
	title: string;
	location: string;
	location_label: string | null;
	city: string | null;
	region: string | null;
	region_code: string | null;
	country: string | null;
	country_code: string | null;
	location_search_terms_json: string;
	career_bucket: string;
	career_bucket_label: string;
	experience_level: string;
	experience_level_label: string;
	yoe_min: number | null;
	yoe_max: number | null;
	experience_display: string;
	authorization_category: string;
	authorization_category_label: string;
	sponsorship_status: string;
	work_authorization_display: string;
	summary: string;
	description_excerpt: string;
	classification_paths_json: string;
	job_link: string;
}

interface FacetRow {
	value: string;
	label?: string;
	count: number;
}

interface Cursor {
	posted_on: string;
	job_id: string;
}

type BindValue = string | number | null;

const JOB_COLUMNS = `
	j.job_id, j.posted_on, j.company, j.title, j.location, j.location_label,
	j.city, j.region, j.region_code, j.country, j.country_code,
	j.location_search_terms_json, j.career_bucket, j.career_bucket_label,
	j.experience_level, j.experience_level_label, j.yoe_min, j.yoe_max,
	j.experience_display, j.authorization_category, j.authorization_category_label,
	j.sponsorship_status, j.work_authorization_display, j.summary,
	j.description_excerpt, j.classification_paths_json, j.job_link
`;

async function activeDataset(db: D1Database): Promise<ActiveDatasetRow | null> {
	return db
		.prepare(
			`SELECT
				dv.version, dv.source_schema_version, dv.taxonomy_version,
				dv.generated_at, dv.imported_at, dv.total_openings,
				dv.posted_within_days, dv.taxonomy_json,
				dv.career_buckets_json, dv.authorization_categories_json,
				dv.sponsorship_statuses_json, state.updated_at AS activated_at
			FROM api_state AS state
			JOIN dataset_versions AS dv ON dv.version = state.active_dataset_version
			WHERE state.singleton = 1
			LIMIT 1`,
		)
		.first<ActiveDatasetRow>();
}

function requireActiveDataset(dataset: ActiveDatasetRow | null): ActiveDatasetRow {
	if (!dataset) {
		throw new ApiError(
			503,
			"dataset_unavailable",
			"No validated job dataset is currently active.",
		);
	}
	return dataset;
}

function parseJson<T>(value: string, field: string): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		throw new ApiError(500, "invalid_stored_data", `Stored ${field} data is invalid.`);
	}
}

function parseJob(row: JobRow) {
	return {
		id: row.job_id,
		posted_on: row.posted_on,
		company: row.company,
		title: row.title,
		location: row.location,
		location_profile: {
			label: row.location_label,
			city: row.city,
			region: row.region,
			region_code: row.region_code,
			country: row.country,
			country_code: row.country_code,
			search_terms: parseJson<string[]>(
				row.location_search_terms_json,
				"location search terms",
			),
		},
		career_bucket: row.career_bucket,
		career_bucket_label: row.career_bucket_label,
		experience_level: row.experience_level,
		experience_level_label: row.experience_level_label,
		yoe_min: row.yoe_min,
		yoe_max: row.yoe_max,
		experience_display: row.experience_display,
		authorization_category: row.authorization_category,
		authorization_category_label: row.authorization_category_label,
		sponsorship_status: row.sponsorship_status,
		work_authorization_display: row.work_authorization_display,
		classification_paths: parseJson<unknown[]>(
			row.classification_paths_json,
			"classification paths",
		),
		summary: row.summary,
		description_excerpt: row.description_excerpt,
		job_link: row.job_link,
	};
}

function readSingleParameter(search: URLSearchParams, name: string): string | null {
	const values = search.getAll(name);
	if (values.length > 1) {
		throw new ApiError(400, "duplicate_parameter", `${name} may be provided only once.`, name);
	}
	if (values.length === 0) return null;
	const value = values[0].trim();
	if (!value) {
		throw new ApiError(400, "invalid_parameter", `${name} must not be empty.`, name);
	}
	if (value.length > MAX_FILTER_LENGTH && name !== "cursor") {
		throw new ApiError(
			400,
			"invalid_parameter",
			`${name} must be at most ${MAX_FILTER_LENGTH} characters.`,
			name,
		);
	}
	return value;
}

function readLimit(search: URLSearchParams): number {
	const raw = readSingleParameter(search, "limit");
	if (raw === null) return DEFAULT_LIMIT;
	if (!/^\d+$/.test(raw)) {
		throw new ApiError(400, "invalid_parameter", "limit must be an integer.", "limit");
	}
	const limit = Number(raw);
	if (limit < 1 || limit > MAX_LIMIT) {
		throw new ApiError(
			400,
			"invalid_parameter",
			`limit must be between 1 and ${MAX_LIMIT}.`,
			"limit",
		);
	}
	return limit;
}

function encodeCursor(cursor: Cursor): string {
	const bytes = new TextEncoder().encode(JSON.stringify(cursor));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(raw: string | null): Cursor | null {
	if (raw === null) return null;
	if (raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
		throw new ApiError(400, "invalid_parameter", "cursor is invalid.", "cursor");
	}
	try {
		const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Cursor>;
		if (
			typeof value.posted_on !== "string" ||
			!/^\d{4}-\d{2}-\d{2}$/.test(value.posted_on) ||
			typeof value.job_id !== "string" ||
			!value.job_id
		) {
			throw new Error("Invalid cursor payload");
		}
		return { posted_on: value.posted_on, job_id: value.job_id };
	} catch {
		throw new ApiError(400, "invalid_parameter", "cursor is invalid.", "cursor");
	}
}

function validateJobParameters(search: URLSearchParams): void {
	for (const name of search.keys()) {
		if (!ALLOWED_JOB_PARAMETERS.has(name)) {
			throw new ApiError(400, "unknown_parameter", `${name} is not a supported filter.`, name);
		}
	}
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}

export async function statusHandler(env: Env): Promise<Response> {
	const dataset = await activeDataset(env.DB);
	if (!dataset) {
		return jsonResponse(
			{ status: "empty", dataset: null },
			200,
			"public, max-age=30",
		);
	}
	return jsonResponse(
		{
			status: "ready",
			dataset: {
				version: dataset.version,
				generated_at: dataset.generated_at,
				imported_at: dataset.imported_at,
				activated_at: dataset.activated_at,
				total_jobs: dataset.total_openings,
				posted_within_days: dataset.posted_within_days,
				schema_version: dataset.source_schema_version,
				taxonomy_version: dataset.taxonomy_version,
			},
		},
		200,
		"public, max-age=30",
	);
}

export async function jobsHandler(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	validateJobParameters(url.searchParams);
	const dataset = requireActiveDataset(await activeDataset(env.DB));
	const limit = readLimit(url.searchParams);
	const cursor = decodeCursor(readSingleParameter(url.searchParams, "cursor"));

	const where = ["j.dataset_version = ?"];
	const bindings: BindValue[] = [dataset.version];
	const filtersApplied: Record<string, string> = {};

	const directFilters: Array<[string, string, string, (value: string) => string]> = [
		["career_bucket", "j.career_bucket", "career_bucket", (value) => value],
		["experience_level", "j.experience_level", "experience_level", (value) => value],
		[
			"authorization_category",
			"j.authorization_category",
			"authorization_category",
			(value) => value,
		],
		["sponsorship_status", "j.sponsorship_status", "sponsorship_status", (value) => value],
		["company", "j.company", "company", (value) => value],
		["state", "j.region_code", "state", (value) => value.toUpperCase()],
	];
	for (const [parameter, column, responseName, normalize] of directFilters) {
		const raw = readSingleParameter(url.searchParams, parameter);
		if (raw !== null) {
			const value = normalize(raw);
			where.push(`${column} = ? COLLATE NOCASE`);
			bindings.push(value);
			filtersApplied[responseName] = value;
		}
	}

	const postedSince = readSingleParameter(url.searchParams, "posted_since");
	if (postedSince !== null) {
		const parsedDate = new Date(`${postedSince}T00:00:00Z`);
		if (
			!/^\d{4}-\d{2}-\d{2}$/.test(postedSince) ||
			Number.isNaN(parsedDate.getTime()) ||
			parsedDate.toISOString().slice(0, 10) !== postedSince
		) {
			throw new ApiError(
				400,
				"invalid_parameter",
				"posted_since must use YYYY-MM-DD format.",
				"posted_since",
			);
		}
		where.push("j.posted_on >= ?");
		bindings.push(postedSince);
		filtersApplied.posted_since = postedSince;
	}

	const keyword = readSingleParameter(url.searchParams, "q");
	if (keyword !== null) {
		where.push("j.search_text LIKE ? ESCAPE '\\'");
		bindings.push(`%${escapeLike(keyword.toLowerCase())}%`);
		filtersApplied.q = keyword;
	}

	const domain = readSingleParameter(url.searchParams, "domain");
	const industry = readSingleParameter(url.searchParams, "industry");
	const specialization = readSingleParameter(url.searchParams, "specialization");
	if (domain !== null || industry !== null || specialization !== null) {
		const classificationWhere = [
			"jc.dataset_version = j.dataset_version",
			"jc.job_id = j.job_id",
		];
		if (domain !== null) {
			classificationWhere.push("jc.domain = ? COLLATE NOCASE");
			bindings.push(domain);
			filtersApplied.domain = domain;
		}
		if (industry !== null) {
			classificationWhere.push("jc.industry = ? COLLATE NOCASE");
			bindings.push(industry);
			filtersApplied.industry = industry;
		}
		if (specialization !== null) {
			classificationWhere.push("js.specialization = ? COLLATE NOCASE");
			bindings.push(specialization);
			filtersApplied.specialization = specialization;
		}
		where.push(
			`EXISTS (
				SELECT 1 FROM job_classifications AS jc
				LEFT JOIN job_specializations AS js
				  ON js.dataset_version = jc.dataset_version
				 AND js.job_id = jc.job_id
				 AND js.path_index = jc.path_index
				WHERE ${classificationWhere.join("\n AND ")}
			)`,
		);
	}

	if (cursor) {
		where.push("(j.posted_on < ? OR (j.posted_on = ? AND j.job_id > ?))");
		bindings.push(cursor.posted_on, cursor.posted_on, cursor.job_id);
	}

	const statement = env.DB.prepare(
		`SELECT ${JOB_COLUMNS}
		 FROM jobs AS j
		 WHERE ${where.join("\n AND ")}
		 ORDER BY j.posted_on DESC, j.job_id ASC
		 LIMIT ?`,
	).bind(...bindings, limit + 1);
	const result = await statement.all<JobRow>();
	const hasMore = result.results.length > limit;
	const rows = result.results.slice(0, limit);
	const lastRow = rows.at(-1);

	return jsonResponse(
		{
			data: rows.map(parseJob),
			pagination: {
				limit,
				returned: rows.length,
				next_cursor:
					hasMore && lastRow
						? encodeCursor({ posted_on: lastRow.posted_on, job_id: lastRow.job_id })
						: null,
			},
			meta: {
				dataset_version: dataset.version,
				dataset_generated_at: dataset.generated_at,
				filters_applied: filtersApplied,
			},
		},
		200,
		"public, max-age=60",
	);
}

export async function jobDetailHandler(
	encodedJobId: string,
	env: Env,
): Promise<Response> {
	let jobId: string;
	try {
		jobId = decodeURIComponent(encodedJobId);
	} catch {
		throw new ApiError(400, "invalid_job_id", "The job ID is not valid URL encoding.");
	}
	if (!jobId || jobId.length > MAX_JOB_ID_LENGTH) {
		throw new ApiError(400, "invalid_job_id", "The job ID is invalid.");
	}
	const dataset = requireActiveDataset(await activeDataset(env.DB));
	const row = await env.DB.prepare(
		`SELECT ${JOB_COLUMNS}
		 FROM jobs AS j
		 WHERE j.dataset_version = ? AND j.job_id = ?
		 LIMIT 1`,
	)
		.bind(dataset.version, jobId)
		.first<JobRow>();
	if (!row) {
		throw new ApiError(404, "job_not_found", "No job with that ID exists in the active dataset.");
	}
	return jsonResponse(
		{
			data: parseJob(row),
			meta: {
				dataset_version: dataset.version,
				dataset_generated_at: dataset.generated_at,
			},
		},
		200,
		"public, max-age=300",
	);
}

export async function facetsHandler(env: Env): Promise<Response> {
	const dataset = requireActiveDataset(await activeDataset(env.DB));
	const version = dataset.version;
	const results = await env.DB.batch<FacetRow>([
		env.DB.prepare(
			`SELECT career_bucket AS value, career_bucket_label AS label, COUNT(*) AS count
			 FROM jobs WHERE dataset_version = ? GROUP BY career_bucket, career_bucket_label
			 ORDER BY count DESC, label ASC`,
		).bind(version),
		env.DB.prepare(
			`SELECT experience_level AS value, experience_level_label AS label, COUNT(*) AS count
			 FROM jobs WHERE dataset_version = ? GROUP BY experience_level, experience_level_label
			 ORDER BY count DESC, label ASC`,
		).bind(version),
		env.DB.prepare(
			`SELECT authorization_category AS value, authorization_category_label AS label,
			        COUNT(*) AS count
			 FROM jobs WHERE dataset_version = ?
			 GROUP BY authorization_category, authorization_category_label
			 ORDER BY count DESC, label ASC`,
		).bind(version),
		env.DB.prepare(
			`SELECT sponsorship_status AS value, COUNT(*) AS count
			 FROM jobs WHERE dataset_version = ? GROUP BY sponsorship_status
			 ORDER BY count DESC, value ASC`,
		).bind(version),
		env.DB.prepare(
			`SELECT region_code AS value, region AS label, COUNT(*) AS count
			 FROM jobs WHERE dataset_version = ? AND region_code <> ''
			 GROUP BY region_code, region ORDER BY count DESC, value ASC`,
		).bind(version),
		env.DB.prepare(
			`SELECT domain AS value, COUNT(DISTINCT job_id) AS count
			 FROM job_classifications WHERE dataset_version = ? GROUP BY domain
			 ORDER BY count DESC, value ASC`,
		).bind(version),
		env.DB.prepare(
			`SELECT specialization AS value, COUNT(DISTINCT job_id) AS count
			 FROM job_specializations WHERE dataset_version = ? GROUP BY specialization
			 ORDER BY count DESC, value ASC`,
		).bind(version),
		env.DB.prepare(
			`SELECT industry AS value, COUNT(DISTINCT job_id) AS count
			 FROM job_classifications WHERE dataset_version = ? GROUP BY industry
			 ORDER BY count DESC, value ASC`,
		).bind(version),
	]);

	return jsonResponse(
		{
			data: {
				career_buckets: results[0].results,
				experience_levels: results[1].results,
				authorization_categories: results[2].results,
				sponsorship_statuses: results[3].results,
				states: results[4].results,
				domains: results[5].results,
				specializations: results[6].results,
				industries: results[7].results,
				taxonomy: parseJson<unknown>(dataset.taxonomy_json, "taxonomy"),
			},
			meta: {
				dataset_version: dataset.version,
				dataset_generated_at: dataset.generated_at,
			},
		},
		200,
		"public, max-age=300",
	);
}
