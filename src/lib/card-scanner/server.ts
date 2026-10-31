// Server-only helpers shared by the card-scanner API routes.

export interface CardScannerEnv {
	/** Shared secret the browser must send in the `x-access-token` header. */
	CARD_SCANNER_ACCESS_TOKEN?: string;
	/** Anthropic API key used to read the business card images. */
	ANTHROPIC_API_KEY?: string;
	/** Apollo.io API key used to verify current title/company. */
	APOLLO_API_KEY?: string;
}

export function getEnv(locals: App.Locals): CardScannerEnv {
	return (locals.runtime?.env ?? {}) as unknown as CardScannerEnv;
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * The API routes spend money (Claude / Apollo credits), so they fail closed:
 * if no access token is configured, every request is rejected.
 */
export function checkAccess(request: Request, env: CardScannerEnv): Response | null {
	const expected = env.CARD_SCANNER_ACCESS_TOKEN;
	if (!expected) {
		return json({ error: 'Server not configured: CARD_SCANNER_ACCESS_TOKEN is missing.' }, 503);
	}
	const given = request.headers.get('x-access-token') ?? '';
	if (!safeEqual(given, expected)) {
		return json({ error: 'Invalid access token.' }, 401);
	}
	return null;
}
