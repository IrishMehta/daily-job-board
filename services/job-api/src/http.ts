export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly parameter?: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

const COMMON_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Access-Control-Max-Age": "86400",
	"X-Content-Type-Options": "nosniff",
};

export function jsonResponse(
	body: unknown,
	status = 200,
	cacheControl = "no-store",
): Response {
	return Response.json(body, {
		status,
		headers: {
			...COMMON_HEADERS,
			"Cache-Control": cacheControl,
		},
	});
}

export function optionsResponse(): Response {
	return new Response(null, { status: 204, headers: COMMON_HEADERS });
}

export function documentResponse(
	body: string,
	contentType: string,
	cacheControl = "public, max-age=300",
): Response {
	return new Response(body, {
		status: 200,
		headers: {
			...COMMON_HEADERS,
			"Cache-Control": cacheControl,
			"Content-Type": contentType,
		},
	});
}

export function errorResponse(error: ApiError): Response {
	return jsonResponse(
		{
			error: {
				code: error.code,
				message: error.message,
				...(error.parameter ? { parameter: error.parameter } : {}),
			},
		},
		error.status,
	);
}
