// Shared types for the business card scanner (used by browser code and API routes).

/** Fields read from the physical business card. */
export interface CardFields {
	firstName: string;
	lastName: string;
	title: string;
	company: string;
	email: string;
	phone: string;
	mobile: string;
	website: string;
	address: string;
	linkedinUrl: string;
}

export type VerificationStatus =
	| 'not_checked'
	| 'confirmed' // provider data matches the card
	| 'changed' // provider reports a different title and/or company
	| 'not_found' // provider has no match
	| 'error';

export interface Verification {
	status: VerificationStatus;
	source: string; // e.g. "Apollo"
	currentTitle: string;
	currentCompany: string;
	linkedinUrl: string;
	checkedAt: string; // ISO timestamp
	note: string;
}

export interface Contact extends CardFields {
	id: string;
	industry: string;
	notes: string;
	scannedAt: string; // ISO timestamp
	verification: Verification;
}

export interface ExtractResponse {
	fields: CardFields;
	suggestedIndustry: string;
}

export interface VerifyResponse {
	verification: Verification;
}

export const EMPTY_FIELDS: CardFields = {
	firstName: '',
	lastName: '',
	title: '',
	company: '',
	email: '',
	phone: '',
	mobile: '',
	website: '',
	address: '',
	linkedinUrl: '',
};

/** Default industry list – the user can type any other value too. */
export const INDUSTRIES = [
	'Automotive',
	'Banking & Financial Services',
	'Chemicals',
	'Construction & Real Estate',
	'Consulting',
	'Consumer Goods & Retail',
	'Education',
	'Energy & Utilities',
	'Food & Beverage',
	'Government & Public Sector',
	'Healthcare & Pharma',
	'Hospitality & Travel',
	'Insurance',
	'IT & Software',
	'Legal',
	'Logistics & Transportation',
	'Manufacturing & Industrial',
	'Marketing & Advertising',
	'Media & Entertainment',
	'Non-Profit',
	'Telecommunications',
	'Other',
];
