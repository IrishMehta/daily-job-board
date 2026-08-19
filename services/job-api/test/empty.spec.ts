import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

async function request(path: string): Promise<Response> {
	return worker.fetch(
		new Request(`https://example.com${path}`),
		env,
		createExecutionContext(),
	);
}

describe("API without an active dataset", () => {
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
