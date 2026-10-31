import type { APIRoute } from 'astro';
import Anthropic from '@anthropic-ai/sdk';
import { checkAccess, getEnv, json } from '../../../lib/card-scanner/server';
import { INDUSTRIES, type CardFields, type ExtractResponse } from '../../../lib/card-scanner/types';

export const prerender = false;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Claude's per-image limit
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type ImageType = (typeof ALLOWED_TYPES)[number];

const FIELD_KEYS: (keyof CardFields)[] = [
	'firstName',
	'lastName',
	'title',
	'company',
	'email',
	'phone',
	'mobile',
	'website',
	'address',
	'linkedinUrl',
];

const SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: [...FIELD_KEYS, 'suggestedIndustry'],
	properties: {
		firstName: { type: 'string' },
		lastName: { type: 'string' },
		title: { type: 'string', description: 'Job title / position exactly as printed' },
		company: { type: 'string' },
		email: { type: 'string' },
		phone: { type: 'string', description: 'Office / landline number incl. country code if printed' },
		mobile: { type: 'string' },
		website: { type: 'string' },
		address: { type: 'string', description: 'Full postal address on one line' },
		linkedinUrl: { type: 'string' },
		suggestedIndustry: {
			type: 'string',
			description: 'Best matching industry of the company, preferably one of the provided list',
		},
	},
};

const SYSTEM = `You read photographed business cards and return the contact data as JSON.
Rules:
- Copy text exactly as printed (keep umlauts/accents). Do not invent data; use "" for anything not on the card.
- If the card has several sides or languages, merge them into one contact.
- Put the job title into "title", not into the name fields. Academic titles (Dr., Prof.) belong to "title" only if no job title exists; otherwise prefix them to firstName.
- "suggestedIndustry": pick the best match from this list based on company name, logo and title: ${INDUSTRIES.join(', ')}. If unsure, use "Other".`;

export const POST: APIRoute = async ({ request, locals }) => {
	const env = getEnv(locals);
	const denied = checkAccess(request, env);
	if (denied) return denied;
	if (!env.ANTHROPIC_API_KEY) {
		return json({ error: 'Server not configured: ANTHROPIC_API_KEY is missing.' }, 503);
	}

	const form = await request.formData().catch(() => null);
	const images = (form?.getAll('image') ?? []).filter((v): v is File => v instanceof File);
	if (images.length === 0) return json({ error: 'No image uploaded.' }, 400);
	if (images.length > 2) return json({ error: 'At most 2 images (front and back).' }, 400);

	const imageBlocks: Anthropic.Beta.BetaImageBlockParam[] = [];
	for (const img of images) {
		if (!ALLOWED_TYPES.includes(img.type as ImageType)) {
			return json({ error: `Unsupported image type: ${img.type}` }, 400);
		}
		if (img.size > MAX_IMAGE_BYTES) return json({ error: 'Image too large (max 5 MB).' }, 400);
		const bytes = new Uint8Array(await img.arrayBuffer());
		imageBlocks.push({
			type: 'image',
			source: { type: 'base64', media_type: img.type as ImageType, data: toBase64(bytes) },
		});
	}

	const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

	try {
		const response = await client.beta.messages.create({
			model: 'claude-opus-5-5',
			max_tokens: 4000,
			betas: ['server-side-fallback-2026-07-01'],
			fallbacks: 'default',
			output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
			system: SYSTEM,
			messages: [
				{
					role: 'user',
					content: [...imageBlocks, { type: 'text', text: 'Extract the contact from this business card.' }],
				},
			],
		});

		if (response.stop_reason === 'refusal') {
			return json({ error: 'The model declined to read this image.' }, 422);
		}
		if (response.stop_reason === 'max_tokens') {
			return json({ error: 'The response was cut off. Please try again.' }, 502);
		}

		const text = response.content.find((b) => b.type === 'text');
		if (!text || text.type !== 'text') return json({ error: 'Empty response from model.' }, 502);

		const parsed = JSON.parse(text.text) as Record<string, unknown>;
		const fields = {} as CardFields;
		for (const key of FIELD_KEYS) fields[key] = String(parsed[key] ?? '').trim();

		const result: ExtractResponse = {
			fields,
			suggestedIndustry: String(parsed.suggestedIndustry ?? '').trim(),
		};
		return json(result);
	} catch (error) {
		if (error instanceof Anthropic.AuthenticationError) {
			return json({ error: 'Anthropic API key is invalid.' }, 502);
		}
		if (error instanceof Anthropic.RateLimitError) {
			return json({ error: 'Rate limited by the Anthropic API – please retry in a moment.' }, 429);
		}
		if (error instanceof Anthropic.APIError) {
			return json({ error: `Anthropic API error ${error.status}: ${error.message}` }, 502);
		}
		if (error instanceof SyntaxError) {
			return json({ error: 'Could not parse the model response.' }, 502);
		}
		throw error;
	}
};

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}
