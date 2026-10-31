import type { APIRoute } from 'astro';
import { checkAccess, getEnv, json } from '../../../lib/card-scanner/server';
import type { CardFields, Verification, VerifyResponse } from '../../../lib/card-scanner/types';

export const prerender = false;

/**
 * Checks whether a contact still holds the position printed on the card.
 *
 * Data source: Apollo.io "People Enrichment" (POST /api/v1/people/match).
 * Apollo's records include the person's current title, employer and LinkedIn URL.
 * LinkedIn itself offers no public API for looking up profiles, and scraping it
 * violates its terms – so LinkedIn is checked by the user via the search link in the UI.
 *
 * Each successful match consumes Apollo credits.
 */
const APOLLO_URL = 'https://api.apollo.io/api/v1/people/match';

interface ApolloPerson {
	title?: string | null;
	linkedin_url?: string | null;
	organization?: { name?: string | null } | null;
	employment_history?: { organization_name?: string | null; title?: string | null; current?: boolean }[] | null;
}

export const POST: APIRoute = async ({ request, locals }) => {
	const env = getEnv(locals);
	const denied = checkAccess(request, env);
	if (denied) return denied;
	if (!env.APOLLO_API_KEY) {
		return json({ error: 'Server not configured: APOLLO_API_KEY is missing.' }, 503);
	}

	const card = (await request.json().catch(() => null)) as Partial<CardFields> | null;
	if (!card || !(card.lastName || card.email || card.linkedinUrl)) {
		return json({ error: 'Need at least a last name, e-mail or LinkedIn URL.' }, 400);
	}

	const body: Record<string, string> = {};
	if (card.firstName) body.first_name = card.firstName;
	if (card.lastName) body.last_name = card.lastName;
	if (card.company) body.organization_name = card.company;
	if (card.email) body.email = card.email;
	if (card.linkedinUrl) body.linkedin_url = card.linkedinUrl;
	const domain = domainOf(card.website) || domainOf(card.email?.split('@')[1]);
	if (domain) body.domain = domain;

	const base: Verification = {
		status: 'error',
		source: 'Apollo',
		currentTitle: '',
		currentCompany: '',
		linkedinUrl: '',
		checkedAt: new Date().toISOString(),
		note: '',
	};

	let res: Response;
	try {
		res = await fetch(APOLLO_URL, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'cache-control': 'no-cache',
				'x-api-key': env.APOLLO_API_KEY,
			},
			body: JSON.stringify(body),
		});
	} catch {
		return json({ verification: { ...base, note: 'Could not reach Apollo.' } } satisfies VerifyResponse);
	}

	if (!res.ok) {
		const note =
			res.status === 401 || res.status === 403
				? 'Apollo rejected the API key (or the plan has no API access).'
				: res.status === 429
					? 'Apollo rate limit reached – try again later.'
					: `Apollo error ${res.status}.`;
		return json({ verification: { ...base, note } } satisfies VerifyResponse);
	}

	const data = (await res.json().catch(() => ({}))) as { person?: ApolloPerson | null };
	const person = data.person;
	if (!person) {
		return json({ verification: { ...base, status: 'not_found', note: 'No match in Apollo.' } } satisfies VerifyResponse);
	}

	const current = person.employment_history?.find((e) => e.current);
	const currentTitle = (person.title || current?.title || '').trim();
	const currentCompany = (person.organization?.name || current?.organization_name || '').trim();

	const titleChanged = !!currentTitle && !!card.title && !similar(currentTitle, card.title);
	const companyChanged = !!currentCompany && !!card.company && !similar(currentCompany, card.company);

	const changes: string[] = [];
	if (companyChanged) changes.push(`company: "${card.company}" → "${currentCompany}"`);
	if (titleChanged) changes.push(`title: "${card.title}" → "${currentTitle}"`);

	const verification: Verification = {
		...base,
		status: changes.length ? 'changed' : 'confirmed',
		currentTitle,
		currentCompany,
		linkedinUrl: (person.linkedin_url || '').trim(),
		note: changes.length ? `Changed ${changes.join('; ')}` : 'Matches the card.',
	};
	return json({ verification } satisfies VerifyResponse);
};

function domainOf(value?: string): string {
	if (!value) return '';
	try {
		const url = new URL(value.includes('://') ? value : `https://${value}`);
		return url.hostname.replace(/^www\./, '');
	} catch {
		return '';
	}
}

/** Loose comparison: ignores case, punctuation and legal suffixes; accepts containment. */
export function similar(a: string, b: string): boolean {
	const norm = (s: string) =>
		s
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.replace(/\b(gmbh|ag|se|kg|ltd|llc|inc|plc|oy|ab|co|corp|corporation|company|group)\b/g, '')
			.replace(/[^a-z0-9]+/g, ' ')
			.trim();
	const x = norm(a);
	const y = norm(b);
	if (!x || !y) return true;
	return x === y || x.includes(y) || y.includes(x);
}
