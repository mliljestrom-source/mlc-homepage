import type { CardFields, Contact, ExtractResponse, VerifyResponse } from '../../lib/card-scanner/types';
import { exportWorkbook, importWorkbook, statusLabel } from './excel';
import { getToken, loadContacts, newContact, saveContacts, setToken } from './store';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let contacts: Contact[] = loadContacts();
let editingId: string | null = null;
let sortKey: keyof Contact | 'status' = 'industry';
let sortAsc = true;

const FORM_FIELDS: (keyof CardFields | 'industry' | 'notes')[] = [
	'firstName',
	'lastName',
	'title',
	'company',
	'industry',
	'email',
	'phone',
	'mobile',
	'website',
	'address',
	'linkedinUrl',
	'notes',
];

// ---------- helpers ----------

function setStatus(message: string, kind: 'info' | 'error' | 'ok' = 'info') {
	const el = $('status');
	el.textContent = message;
	el.dataset.kind = kind;
}

async function api<T>(path: string, init: RequestInit): Promise<T> {
	const headers = new Headers(init.headers);
	headers.set('x-access-token', getToken());
	const res = await fetch(path, { ...init, headers });
	const body = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
	return body;
}

/** Downscale photos so uploads are fast and stay under Claude's 5 MB image limit. */
async function shrinkImage(file: File, maxSide = 1600): Promise<Blob> {
	const bitmap = await createImageBitmap(file);
	const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	return new Promise((resolve, reject) =>
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image conversion failed'))), 'image/jpeg', 0.85),
	);
}

export function linkedinSearchUrl(c: Pick<Contact, 'firstName' | 'lastName' | 'company'>): string {
	const q = [c.firstName, c.lastName, c.company].filter(Boolean).join(' ');
	return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`;
}

function persist() {
	saveContacts(contacts);
	renderTable();
}

// ---------- review form ----------

function fillForm(data: Partial<Contact>) {
	for (const key of FORM_FIELDS) {
		($(`f-${key}`) as HTMLInputElement).value = String(data[key] ?? '');
	}
}

function readForm(): Partial<Contact> {
	const out: Partial<Contact> = {};
	for (const key of FORM_FIELDS) {
		(out as Record<string, string>)[key] = ($(`f-${key}`) as HTMLInputElement).value.trim();
	}
	return out;
}

function openForm(title: string, data: Partial<Contact>, id: string | null) {
	editingId = id;
	$('form-title').textContent = title;
	fillForm(data);
	$('review').hidden = false;
	$('review').scrollIntoView({ behavior: 'smooth' });
}

function closeForm() {
	editingId = null;
	$('review').hidden = true;
	($('card-form') as HTMLFormElement).reset();
}

// ---------- scanning ----------

async function scan() {
	const front = ($('front') as HTMLInputElement).files?.[0];
	const back = ($('back') as HTMLInputElement).files?.[0];
	if (!front) return setStatus('Please take or choose a photo of the card first.', 'error');
	if (!getToken()) return setStatus('Enter your access token under "Settings" first.', 'error');

	const button = $('scan-btn') as HTMLButtonElement;
	button.disabled = true;
	setStatus('Reading card…');
	try {
		const form = new FormData();
		form.append('image', await shrinkImage(front), 'front.jpg');
		if (back) form.append('image', await shrinkImage(back), 'back.jpg');
		const result = await api<ExtractResponse>('/api/card-scanner/extract', { method: 'POST', body: form });
		openForm('Check the scanned data', { ...result.fields, industry: result.suggestedIndustry }, null);
		setStatus('Card read – please check the fields, choose the industry and save.', 'ok');
	} catch (e) {
		setStatus((e as Error).message, 'error');
	} finally {
		button.disabled = false;
	}
}

function saveForm(event: Event) {
	event.preventDefault();
	const data = readForm();
	if (!data.firstName && !data.lastName && !data.company) {
		return setStatus('Please enter at least a name or company.', 'error');
	}
	if (editingId) {
		contacts = contacts.map((c) => (c.id === editingId ? { ...c, ...data } : c));
	} else {
		contacts.push({ ...newContact(), ...data });
	}
	persist();
	closeForm();
	($('front') as HTMLInputElement).value = '';
	($('back') as HTMLInputElement).value = '';
	updatePreviews();
	setStatus('Contact saved.', 'ok');
}

// ---------- verification ----------

async function verify(contact: Contact): Promise<void> {
	const result = await api<VerifyResponse>('/api/card-scanner/verify', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(contact),
	});
	contacts = contacts.map((c) => (c.id === contact.id ? { ...c, verification: result.verification } : c));
	persist();
}

async function verifyAll() {
	if (!getToken()) return setStatus('Enter your access token under "Settings" first.', 'error');
	const list = filteredContacts();
	if (!list.length) return;
	if (!confirm(`Check ${list.length} contact(s) via Apollo? Each lookup uses Apollo credits.`)) return;
	let changed = 0;
	for (const [i, c] of list.entries()) {
		setStatus(`Checking ${i + 1}/${list.length}: ${c.firstName} ${c.lastName}…`);
		try {
			await verify(c);
			if (contacts.find((x) => x.id === c.id)?.verification.status === 'changed') changed++;
		} catch (e) {
			return setStatus((e as Error).message, 'error');
		}
	}
	setStatus(`Done. ${changed} contact(s) with a changed position.`, changed ? 'error' : 'ok');
}

// ---------- table ----------

function filteredContacts(): Contact[] {
	const industry = ($('industry-filter') as HTMLSelectElement).value;
	const search = ($('search') as HTMLInputElement).value.trim().toLowerCase();
	return contacts
		.filter((c) => !industry || (industry === '__none__' ? !c.industry : c.industry === industry))
		.filter((c) => !search || JSON.stringify(c).toLowerCase().includes(search))
		.sort((a, b) => {
			const va = sortKey === 'status' ? statusLabel(a) : String(a[sortKey] ?? '');
			const vb = sortKey === 'status' ? statusLabel(b) : String(b[sortKey] ?? '');
			// Empty values always go last; ties are broken by company, then last name.
			if (!va !== !vb) return va ? -1 : 1;
			const primary = va.localeCompare(vb, undefined, { sensitivity: 'base' }) * (sortAsc ? 1 : -1);
			return primary || a.company.localeCompare(b.company) || a.lastName.localeCompare(b.lastName);
		});
}

function renderIndustryOptions() {
	const industries = [...new Set(contacts.map((c) => c.industry).filter(Boolean))].sort();
	const select = $('industry-filter') as HTMLSelectElement;
	const current = select.value;
	select.replaceChildren(new Option('All industries', ''), ...industries.map((i) => new Option(i, i)));
	if (contacts.some((c) => !c.industry)) select.add(new Option('(no industry)', '__none__'));
	select.value = [...select.options].some((o) => o.value === current) ? current : '';
}

function cell(text: string, className?: string): HTMLTableCellElement {
	const td = document.createElement('td');
	td.textContent = text;
	if (className) td.className = className;
	return td;
}

function button(label: string, onClick: () => void, title?: string): HTMLButtonElement {
	const b = document.createElement('button');
	b.type = 'button';
	b.textContent = label;
	if (title) b.title = title;
	b.addEventListener('click', onClick);
	return b;
}

function renderTable() {
	renderIndustryOptions();
	const list = filteredContacts();
	const tbody = $('contacts-body');
	tbody.replaceChildren();

	for (const c of list) {
		const tr = document.createElement('tr');
		if (c.verification.status === 'changed') tr.className = 'changed';

		tr.append(
			cell(c.industry || '—'),
			cell(`${c.firstName} ${c.lastName}`.trim()),
			cell(c.title),
			cell(c.company),
			cell(c.email),
		);

		const statusTd = cell(statusLabel(c), `status-${c.verification.status}`);
		if (c.verification.note) statusTd.title = c.verification.note;
		if (c.verification.status === 'changed') {
			const detail = document.createElement('div');
			detail.className = 'detail';
			detail.textContent = `Now: ${c.verification.currentTitle} @ ${c.verification.currentCompany}`;
			statusTd.append(detail);
		}
		tr.append(statusTd);

		const actions = document.createElement('td');
		actions.className = 'actions';
		const li = document.createElement('a');
		li.href = c.linkedinUrl || c.verification.linkedinUrl || linkedinSearchUrl(c);
		li.target = '_blank';
		li.rel = 'noopener noreferrer';
		li.textContent = 'LinkedIn';
		li.title = 'Open LinkedIn to check the current position';
		actions.append(
			li,
			button('Verify', async () => {
				if (!getToken()) return setStatus('Enter your access token under "Settings" first.', 'error');
				setStatus(`Checking ${c.firstName} ${c.lastName}…`);
				try {
					await verify(c);
					const updated = contacts.find((x) => x.id === c.id)!;
					setStatus(`${c.firstName} ${c.lastName}: ${updated.verification.note}`, updated.verification.status === 'changed' ? 'error' : 'ok');
				} catch (e) {
					setStatus((e as Error).message, 'error');
				}
			}, 'Check current title/company via Apollo'),
			button('Edit', () => openForm('Edit contact', c, c.id)),
		);
		if (c.verification.status === 'changed') {
			actions.append(
				button('Accept change', () => {
					contacts = contacts.map((x) =>
						x.id === c.id
							? {
									...x,
									title: x.verification.currentTitle || x.title,
									company: x.verification.currentCompany || x.company,
									linkedinUrl: x.linkedinUrl || x.verification.linkedinUrl,
									verification: { ...x.verification, status: 'confirmed', note: `Updated (card said: ${x.title} @ ${x.company}).` },
								}
							: x,
					);
					persist();
				}, 'Replace title/company with the verified current values'),
			);
		}
		actions.append(
			button('Delete', () => {
				if (!confirm(`Delete ${c.firstName} ${c.lastName}?`)) return;
				contacts = contacts.filter((x) => x.id !== c.id);
				persist();
			}),
		);
		tr.append(actions);
		tbody.append(tr);
	}

	$('count').textContent = `${list.length} of ${contacts.length} contact(s)`;
	document.querySelectorAll<HTMLElement>('th[data-sort]').forEach((th) => {
		th.dataset.active = th.dataset.sort === sortKey ? (sortAsc ? 'asc' : 'desc') : '';
	});
}

// ---------- previews ----------

function updatePreviews() {
	for (const side of ['front', 'back']) {
		const file = ($(side) as HTMLInputElement).files?.[0];
		const img = $(`${side}-preview`) as HTMLImageElement;
		if (img.src) URL.revokeObjectURL(img.src);
		if (file) {
			img.src = URL.createObjectURL(file);
			img.hidden = false;
		} else {
			img.removeAttribute('src');
			img.hidden = true;
		}
	}
}

// ---------- wiring ----------

function init() {
	($('token') as HTMLInputElement).value = getToken();
	$('token').addEventListener('change', (e) => {
		setToken((e.target as HTMLInputElement).value);
		setStatus('Access token saved in this browser.', 'ok');
	});

	$('front').addEventListener('change', updatePreviews);
	$('back').addEventListener('change', updatePreviews);
	$('scan-btn').addEventListener('click', scan);
	$('manual-btn').addEventListener('click', () => openForm('New contact', {}, null));
	$('card-form').addEventListener('submit', saveForm);
	$('cancel-btn').addEventListener('click', closeForm);

	$('industry-filter').addEventListener('change', renderTable);
	$('search').addEventListener('input', renderTable);
	document.querySelectorAll<HTMLElement>('th[data-sort]').forEach((th) =>
		th.addEventListener('click', () => {
			const key = th.dataset.sort as typeof sortKey;
			sortAsc = sortKey === key ? !sortAsc : true;
			sortKey = key;
			renderTable();
		}),
	);

	$('verify-all-btn').addEventListener('click', verifyAll);
	$('export-btn').addEventListener('click', async () => {
		const list = filteredContacts();
		if (!list.length) return setStatus('No contacts to export.', 'error');
		const perIndustry = ($('per-industry') as HTMLInputElement).checked;
		const date = new Date().toISOString().slice(0, 10);
		await exportWorkbook(list, perIndustry, `business-cards-${date}.xlsx`);
		setStatus(`Exported ${list.length} contact(s).`, 'ok');
	});
	$('import').addEventListener('change', async (e) => {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			const imported = await importWorkbook(file);
			const key = (c: Contact) =>
				(c.email || `${c.firstName}|${c.lastName}|${c.company}`).trim().toLowerCase();
			const existing = new Set(contacts.map(key));
			const fresh = imported.filter((c) => !existing.has(key(c)) && existing.add(key(c)));
			contacts.push(...fresh);
			persist();
			const skipped = imported.length - fresh.length;
			setStatus(
				`Imported ${fresh.length} contact(s) from ${file.name}` + (skipped ? ` (${skipped} duplicate(s) skipped).` : '.'),
				'ok',
			);
		} catch (err) {
			setStatus(`Import failed: ${(err as Error).message}`, 'error');
		} finally {
			input.value = '';
		}
	});

	renderTable();
}

init();
