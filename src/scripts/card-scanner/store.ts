import { EMPTY_FIELDS, type Contact } from '../../lib/card-scanner/types';

// Contacts are stored only in this browser (localStorage). Export to .xlsx for backup/sharing.
const KEY = 'card-scanner.contacts.v1';
const TOKEN_KEY = 'card-scanner.access-token';

export function newContact(): Contact {
	return {
		...EMPTY_FIELDS,
		id: crypto.randomUUID(),
		industry: '',
		notes: '',
		scannedAt: new Date().toISOString(),
		verification: {
			status: 'not_checked',
			source: '',
			currentTitle: '',
			currentCompany: '',
			linkedinUrl: '',
			checkedAt: '',
			note: '',
		},
	};
}

export function loadContacts(): Contact[] {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as Contact[];
		// Fill in fields added in later versions.
		return parsed.map((c) => ({ ...newContact(), ...c, verification: { ...newContact().verification, ...c.verification } }));
	} catch {
		return [];
	}
}

export function saveContacts(contacts: Contact[]): void {
	localStorage.setItem(KEY, JSON.stringify(contacts));
}

export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t.trim());
