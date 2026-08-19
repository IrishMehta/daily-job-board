import {
	facetsHandler,
	jobDetailHandler,
	jobsHandler,
	statusHandler,
} from "./api";
import {
	ApiError,
	errorResponse,
	jsonResponse,
	optionsResponse,
} from "./http";

const SERVICE_DESCRIPTION = {
	name: "Irish Mehta Public Job API",
	version: "v1",
	endpoints: {
		status: "/v1/status",
		jobs: "/v1/jobs",
		job_detail: "/v1/jobs/{url-encoded-job-id}",
		facets: "/v1/facets",
	},
};

export default {
	async fetch(request, env): Promise<Response> {
		if (request.method === "OPTIONS") return optionsResponse();
		if (request.method !== "GET") {
			return errorResponse(
				new ApiError(405, "method_not_allowed", "Only GET and OPTIONS are supported."),
			);
		}

		try {
			const url = new URL(request.url);
			if (url.pathname === "/") {
				return jsonResponse(SERVICE_DESCRIPTION, 200, "public, max-age=300");
			}
			if (url.pathname === "/v1/status") return await statusHandler(env);
			if (url.pathname === "/v1/jobs") return await jobsHandler(request, env);
			if (url.pathname === "/v1/facets") return await facetsHandler(env);
			if (url.pathname.startsWith("/v1/jobs/") && url.pathname.length > 9) {
				return await jobDetailHandler(url.pathname.slice(9), env);
			}
			throw new ApiError(404, "not_found", "The requested endpoint does not exist.");
		} catch (error) {
			if (error instanceof ApiError) return errorResponse(error);
			console.error("Unhandled API error", error);
			return errorResponse(
				new ApiError(500, "internal_error", "The API could not complete the request."),
			);
		}
	},
} satisfies ExportedHandler<Env>;
