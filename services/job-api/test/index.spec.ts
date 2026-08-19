import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";

const DATASET_VERSION = "test-dataset";
const JOB_ONE = "https://example.com/jobs/1";
const JOB_TWO = "https://example.com/jobs/2";
const JOB_THREE = "https://example.com/jobs/3";

async function insertJob(options: {
	id: string;
	postedOn: string;
	title: string;
	company: string;
	state: string;
	careerBucket: string;
	domain: string;
	specialization: string;
	searchText: string;
}): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO jobs (
				dataset_version, job_id, posted_on, company, title, location,
				location_label, city, region, region_code, country, country_code,
				location_search_terms_json, career_bucket, career_bucket_label,
				experience_level, experience_level_label, yoe_min, yoe_max,
				experience_display, authorization_category,
				authorization_category_label, sponsorship_status,
				work_authorization_display, summary, description_excerpt,
				match_terms_json, classification_paths_json, job_link, search_text
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			)`,
		).bind(
			DATASET_VERSION,
			options.id,
			options.postedOn,
			options.company,
			options.title,
			`Phoenix, ${options.state}`,
			`Phoenix, ${options.state}`,
			"Phoenix",
			"Arizona",
			options.state,
			"United States",
			"US",
			JSON.stringify(["Phoenix", options.state]),
			options.careerBucket,
			options.careerBucket === "early_career" ? "Early Career" : "Mid-Career / Senior",
			"entry_level",
			"Entry level",
			0,
			2,
			"0-2 years",
			"open_or_not_specified",
			"Open / Not specified",
			"not_stated",
			"Not stated",
			`${options.title} at ${options.company}`,
			"Public excerpt",
			JSON.stringify(options.searchText.split(" ")),
			JSON.stringify([
				{
					domain: options.domain,
					specializations: [options.specialization],
					industry: "technology",
					confidence: "high",
				},
			]),
			options.id,
			options.searchText,
		),
		env.DB.prepare(
			`INSERT INTO job_classifications
			 (dataset_version, job_id, path_index, domain, industry, confidence)
			 VALUES (?, ?, 0, ?, 'technology', 'high')`,
		).bind(DATASET_VERSION, options.id, options.domain),
		env.DB.prepare(
			`INSERT INTO job_specializations
			 (dataset_version, job_id, path_index, specialization)
			 VALUES (?, ?, 0, ?)`,
		).bind(DATASET_VERSION, options.id, options.specialization),
	]);
}

async function request(path: string, method = "GET"): Promise<Response> {
	return worker.fetch(
		new Request(`https://example.com${path}`, { method }),
		env,
	);
}

beforeAll(async () => {
	await env.DB.prepare(
		`INSERT INTO dataset_versions (
			version, source_sha256, source_schema_version, taxonomy_version,
			generated_at, total_openings, posted_within_days, taxonomy_json,
			career_buckets_json, authorization_categories_json,
			sponsorship_statuses_json
		) VALUES (?, ?, '3', 'taxonomy-test', '2026-08-19T08:00:00Z', 3, 30,
		          '{}', '[]', '[]', '[]')`,
	)
		.bind(DATASET_VERSION, "a".repeat(64))
		.run();

	await insertJob({
		id: JOB_ONE,
		postedOn: "2026-08-19",
		title: "Machine Learning Engineer",
		company: "Alpha AI",
		state: "AZ",
		careerBucket: "early_career",
		domain: "machine_learning_ai",
		specialization: "ml_engineering",
		searchText: "machine learning production",
	});
	await insertJob({
		id: JOB_TWO,
		postedOn: "2026-08-18",
		title: "Research Scientist",
		company: "Beta Labs",
		state: "CA",
		careerBucket: "mid_career_or_senior",
		domain: "machine_learning_ai",
		specialization: "applied_science",
		searchText: "research scientist",
	});
	await insertJob({
		id: JOB_THREE,
		postedOn: "2026-08-17",
		title: "Data Scientist",
		company: "Gamma Data",
		state: "AZ",
		careerBucket: "early_career",
		domain: "data_analytics",
		specialization: "data_science",
		searchText: "data scientist analytics",
	});
	await env.DB.prepare(
		"UPDATE api_state SET active_dataset_version = ? WHERE singleton = 1",
	)
		.bind(DATASET_VERSION)
		.run();
});

describe("public job API", () => {
	it("reports the active dataset", async () => {
		const response = await request("/v1/status");
		expect(response.status).toBe(200);
		const body = await response.json<any>();
		expect(body.status).toBe("ready");
		expect(body.dataset.total_jobs).toBe(3);
	});

	it("combines career, domain, specialization, and state filters", async () => {
		const response = await request(
			"/v1/jobs?career_bucket=early_career&domain=machine_learning_ai" +
				"&specialization=ml_engineering&state=az",
		);
		expect(response.status).toBe(200);
		const body = await response.json<any>();
		expect(body.data.map((job: any) => job.id)).toEqual([JOB_ONE]);
		expect(body.meta.filters_applied).toMatchObject({
			career_bucket: "early_career",
			domain: "machine_learning_ai",
			specialization: "ml_engineering",
			state: "AZ",
		});
	});

	it("supports deterministic cursor pagination", async () => {
		const firstResponse = await request("/v1/jobs?limit=2");
		const firstBody = await firstResponse.json<any>();
		expect(firstBody.data.map((job: any) => job.id)).toEqual([JOB_ONE, JOB_TWO]);
		expect(firstBody.pagination.next_cursor).toBeTypeOf("string");

		const secondResponse = await request(
			`/v1/jobs?limit=2&cursor=${firstBody.pagination.next_cursor}`,
		);
		const secondBody = await secondResponse.json<any>();
		expect(secondBody.data.map((job: any) => job.id)).toEqual([JOB_THREE]);
		expect(secondBody.pagination.next_cursor).toBeNull();
	});

	it("returns a job by URL-encoded stable ID", async () => {
		const response = await request(`/v1/jobs/${encodeURIComponent(JOB_ONE)}`);
		expect(response.status).toBe(200);
		const body = await response.json<any>();
		expect(body.data.id).toBe(JOB_ONE);
		expect(body.data.classification_paths[0].domain).toBe("machine_learning_ai");
	});

	it("returns count-bearing facets", async () => {
		const response = await request("/v1/facets");
		expect(response.status).toBe(200);
		const body = await response.json<any>();
		expect(body.data.domains).toContainEqual({ value: "machine_learning_ai", count: 2 });
		expect(body.data.states).toContainEqual({ value: "AZ", label: "Arizona", count: 2 });
	});

	it("rejects unsupported and invalid parameters", async () => {
		const unknown = await request("/v1/jobs?seniority=early");
		expect(unknown.status).toBe(400);
		expect((await unknown.json<any>()).error.code).toBe("unknown_parameter");

		const invalidLimit = await request("/v1/jobs?limit=500");
		expect(invalidLimit.status).toBe(400);
		expect((await invalidLimit.json<any>()).error.parameter).toBe("limit");
	});

	it("exposes CORS and rejects writes", async () => {
		const options = await request("/v1/jobs", "OPTIONS");
		expect(options.status).toBe(204);
		expect(options.headers.get("Access-Control-Allow-Origin")).toBe("*");

		const post = await request("/v1/jobs", "POST");
		expect(post.status).toBe(405);
	});
});
