import type { FikenCompany, FikenInvoice, FikenPurchase, FikenJournalEntry } from './types';
import { STUB_INVOICES, STUB_PURCHASES } from './stub';

const BASE_URL = 'https://api.fiken.no/api/v2';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
}

function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function getToken(): string | null {
  return process.env.FIKEN_API_TOKEN ?? null;
}

export function isStubMode(): boolean {
  return !getToken();
}

async function fikenFetch<T>(path: string, opts?: { method?: string }): Promise<T> {
  const token = getToken();
  if (!token) throw new Error('FIKEN_API_TOKEN not configured');

  const res = await fetch(`${BASE_URL}${path}`, {
    method: opts?.method ?? 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
  });

  if (res.status === 429) {
    throw new Error('Fiken rate limit exceeded');
  }
  if (!res.ok) {
    throw new Error(`Fiken API ${res.status}: ${res.statusText}`);
  }

  return res.json() as Promise<T>;
}

/** Get all pages for a paginated endpoint */
async function fikenFetchAll<T>(path: string): Promise<T[]> {
  const results: T[] = [];
  let page = 0;
  const pageSize = 100;

  const MAX_PAGES = 100;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const items = await fikenFetch<T[]>(`${path}${sep}page=${page}&pageSize=${pageSize}`);
    if (!Array.isArray(items) || items.length === 0) break;
    results.push(...items);
    if (items.length < pageSize) break;
    page++;
    if (page > MAX_PAGES) {
      console.warn(`[fiken] Pagination safety cap (${MAX_PAGES}) hit for ${path}. Results may be incomplete.`);
      break;
    }
  }

  return results;
}

export async function getCompanySlug(): Promise<string> {
  if (isStubMode()) return 'stub-company';
  const cached = cacheGet<string>('companySlug');
  if (cached) return cached;
  const companies = await fikenFetch<FikenCompany[]>('/companies');
  const slug = companies[0]?.slug;
  if (!slug) throw new Error('No Fiken company found');
  cacheSet('companySlug', slug, 60 * 60 * 1000); // 1 hour
  return slug;
}

export async function listInvoices(opts?: { fromDate?: string; toDate?: string }): Promise<{ invoices: FikenInvoice[]; source: 'fiken' | 'stub' }> {
  if (isStubMode()) {
    let inv = STUB_INVOICES;
    if (opts?.fromDate) inv = inv.filter(i => i.issueDate >= opts.fromDate!);
    if (opts?.toDate) inv = inv.filter(i => i.issueDate <= opts.toDate!);
    return { invoices: inv, source: 'stub' };
  }

  const slug = await getCompanySlug();
  const cacheKey = `invoices:${opts?.fromDate ?? ''}:${opts?.toDate ?? ''}`;
  const cached = cacheGet<FikenInvoice[]>(cacheKey);
  if (cached) return { invoices: cached, source: 'fiken' };

  const params: string[] = ['sort=lastModified'];
  if (opts?.fromDate) params.push(`issueDateFrom=${opts.fromDate}`);
  if (opts?.toDate) params.push(`issueDateTo=${opts.toDate}`);
  const invoices = await fikenFetchAll<FikenInvoice>(`/companies/${slug}/invoices?${params.join('&')}`);
  cacheSet(cacheKey, invoices, 5 * 60 * 1000); // 5 min
  return { invoices, source: 'fiken' };
}

export async function listPurchases(opts?: { fromDate?: string; toDate?: string }): Promise<{ purchases: FikenPurchase[]; source: 'fiken' | 'stub' }> {
  if (isStubMode()) {
    let p = STUB_PURCHASES;
    if (opts?.fromDate) p = p.filter(x => x.date >= opts.fromDate!);
    if (opts?.toDate) p = p.filter(x => x.date <= opts.toDate!);
    return { purchases: p, source: 'stub' };
  }

  const slug = await getCompanySlug();
  const cacheKey = `purchases:${opts?.fromDate ?? ''}:${opts?.toDate ?? ''}`;
  const cached = cacheGet<FikenPurchase[]>(cacheKey);
  if (cached) return { purchases: cached, source: 'fiken' };

  const params: string[] = ['sort=createdDate'];
  if (opts?.fromDate) params.push(`dateFrom=${opts.fromDate}`);
  if (opts?.toDate) params.push(`dateTo=${opts.toDate}`);
  const purchases = await fikenFetchAll<FikenPurchase>(`/companies/${slug}/purchases?${params.join('&')}`);
  cacheSet(cacheKey, purchases, 5 * 60 * 1000);
  return { purchases, source: 'fiken' };
}

export async function listJournalEntries(opts: { fromDate: string; toDate: string }): Promise<FikenJournalEntry[]> {
  if (isStubMode()) return []; // VAT calc handled separately for stub
  const slug = await getCompanySlug();
  const cacheKey = `journal:${opts.fromDate}:${opts.toDate}`;
  const cached = cacheGet<FikenJournalEntry[]>(cacheKey);
  if (cached) return cached;
  const entries = await fikenFetchAll<FikenJournalEntry>(`/companies/${slug}/journalEntries?dateGe=${opts.fromDate}&dateLe=${opts.toDate}`);
  cacheSet(cacheKey, entries, 5 * 60 * 1000);
  return entries;
}
