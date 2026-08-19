import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

async function request(path: string): Promise<Response> {
	return worker.fetch(
		new Request(`https://example.com${path}`),
		env,
	);
}

describe("API without an active dataset", () => {
	it("serves human and machine-readable documentation without a dataset", async () => {
		const docs = await request("/docs");
		expect(docs.status).toBe(200);
		expect(docs.headers.get("Content-Type")).toContain("text/html");
		const docsHtml = await docs.text();
		expect(docsHtml).toContain("Search the public job board programmatically");
		expect(docsHtml).toContain("ai_machine_learning");
		expect(docsHtml).toContain("state=CA");

		const openapi = await request("/openapi.json");
		expect(openapi.status).toBe(200);
		const contract = await openapi.json<any>();
		expect(contract.openapi).toBe("3.1.0");
		expect(contract.servers).toEqual([{ url: "https://example.com" }]);
		expect(contract.paths["/v1/jobs"].get.operationId).toBe("searchJobs");

		const llms = await request("/llms.txt");
		expect(llms.status).toBe(200);
		expect(llms.headers.get("Content-Type")).toContain("text/plain");
		const instructions = await llms.text();
		expect(instructions).toContain("GET https://example.com/v1/facets");
		expect(instructions).toContain("early_career_or_new_grad");
		expect(instructions).toContain("state=CA");
		expect(instructions).toContain("Empty and sparse result policy");
		expect(instructions).toContain("Never silently remove or widen state");
		expect(instructions).toContain("does not install the API as a native tool");
	});

	it("reports an empty but operational status", async () => {
		const response = await request("/v1/status");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "empty", dataset: null });
	});

	it("does not serve jobs before validated activation", async () => {
		const response = await request("/v1/jobs");
		expect(response.status).toBe(503);
		const body = await response.json<any>();
		expect(body.error.code).toBe("dataset_unavailable");
	});
});
