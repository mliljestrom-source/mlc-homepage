import writeExcelFile from 'write-excel-file/browser';
import { readSheet } from 'read-excel-file/browser';
import type { Contact } from '../../lib/card-scanner/types';
import { newContact } from './store';

/** Column layout of the exported workbook. The same headers are used when importing. */
const COLUMNS: { header: string; width: number; get: (c: Contact) => string; set?: (c: Contact, v: string) => void }[] = [
	{ header: 'Industry', width: 26, get: (c) => c.industry, set: (c, v) => (c.industry = v) },
	{ header: 'Company', width: 28, get: (c) => c.company, set: (c, v) => (c.company = v) },
	{ header: 'First Name', width: 16, get: (c) => c.firstName, set: (c, v) => (c.firstName = v) },
	{ header: 'Last Name', width: 18, get: (c) => c.lastName, set: (c, v) => (c.lastName = v) },
	{ header: 'Title (Card)', width: 28, get: (c) => c.title, set: (c, v) => (c.title = v) },
	{ header: 'Email', width: 30, get: (c) => c.email, set: (c, v) => (c.email = v) },
	{ header: 'Phone', width: 18, get: (c) => c.phone, set: (c, v) => (c.phone = v) },
	{ header: 'Mobile', width: 18, get: (c) => c.mobile, set: (c, v) => (c.mobile = v) },
	{ header: 'Website', width: 24, get: (c) => c.website, set: (c, v) => (c.website = v) },
	{ header: 'Address', width: 40, get: (c) => c.address, set: (c, v) => (c.address = v) },
	{ header: 'LinkedIn URL', width: 36, get: (c) => c.linkedinUrl || c.verification.linkedinUrl, set: (c, v) => (c.linkedinUrl = v) },
	{ header: 'Notes', width: 30, get: (c) => c.notes, set: (c, v) => (c.notes = v) },
	{ header: 'Scanned At', width: 12, get: (c) => c.scannedAt.slice(0, 10) },
	{ header: 'Verification Status', width: 18, get: (c) => statusLabel(c) },
	{ header: 'Current Title (Verified)', width: 28, get: (c) => c.verification.currentTitle },
	{ header: 'Current Company (Verified)', width: 28, get: (c) => c.verification.currentCompany },
	{ header: 'Verification Note', width: 40, get: (c) => c.verification.note },
	{ header: 'Verified At', width: 12, get: (c) => c.verification.checkedAt.slice(0, 10) },
	{ header: 'Verification Source', width: 14, get: (c) => c.verification.source },
];

export function statusLabel(c: Contact): string {
	switch (c.verification.status) {
		case 'confirmed':
			return 'Confirmed';
		case 'changed':
			return 'POSITION CHANGED';
		case 'not_found':
			return 'Not found';
		case 'error':
			return 'Check failed';
		default:
			return 'Not checked';
	}
}

const HEADER_STYLE = { fontWeight: 'bold', backgroundColor: '#1F4E79', textColor: '#FFFFFF' } as const;

function sheetRows(contacts: Contact[]) {
	const header = COLUMNS.map((col) => ({ value: col.header, ...HEADER_STYLE }));
	const rows = contacts.map((c) =>
		COLUMNS.map((col) => {
			const value = col.get(c) || null;
			if (col.header === 'Verification Status' && c.verification.status === 'changed') {
				return { value, backgroundColor: '#FFC7CE', fontWeight: 'bold' as const };
			}
			return value;
		}),
	);
	return [header, ...rows];
}

/** Excel sheet names: max 31 chars, no []:*?/\ */
function sheetName(name: string, used: Set<string>): string {
	let base = (name || 'No industry').replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Sheet';
	let candidate = base;
	for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${base.slice(0, 27)} (${i})`;
	used.add(candidate.toLowerCase());
	return candidate;
}

export async function exportWorkbook(contacts: Contact[], perIndustrySheets: boolean, fileName: string) {
	const columns = COLUMNS.map((c) => ({ width: c.width }));
	const used = new Set<string>();
	const sheets = [{ data: sheetRows(contacts), sheet: sheetName('All Contacts', used), columns, stickyRowsCount: 1 }];

	if (perIndustrySheets) {
		const groups = new Map<string, Contact[]>();
		for (const c of contacts) {
			const key = c.industry || 'No industry';
			groups.set(key, [...(groups.get(key) ?? []), c]);
		}
		for (const [industry, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			sheets.push({ data: sheetRows(list), sheet: sheetName(industry, used), columns, stickyRowsCount: 1 });
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	await writeExcelFile(sheets as any).toFile(fileName);
}

/** Imports contacts from the first sheet of an .xlsx that uses the headers above (e.g. a previous export). */
export async function importWorkbook(file: File): Promise<Contact[]> {
	const rows = (await readSheet(file)) as unknown[][];
	if (rows.length < 2) return [];
	const headers = rows[0].map((h) => String(h ?? '').trim().toLowerCase());
	const indexOf = new Map(COLUMNS.map((col) => [col.header, headers.indexOf(col.header.toLowerCase())]));

	const contacts: Contact[] = [];
	for (const row of rows.slice(1)) {
		const c = newContact();
		let hasData = false;
		for (const col of COLUMNS) {
			const i = indexOf.get(col.header) ?? -1;
			if (i < 0 || !col.set) continue;
			const value = String(row[i] ?? '').trim();
			if (value) {
				col.set(c, value);
				hasData = true;
			}
		}
		if (hasData) contacts.push(c);
	}
	return contacts;
}
