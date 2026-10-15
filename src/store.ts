/**
 * D1 reads for mcps/portugal-tenders.
 *
 * Data: IMPIC (Instituto dos Mercados Públicos, do Imobiliário e da
 * Construção — Portugal's public-procurement regulator, which runs the
 * national tender register at base.gov.pt / "Portal BASE") publishes the
 * same fields BASE exposes through its own API as open-data files on
 * dados.gov.pt, one JSON/XLSX (announcements) or ZIP-of-JSON (contracts)
 * resource PER YEAR. There is no server-side search of these files, so a
 * keyword/CPV/buyer/supplier/amount/date search has to run against a
 * locally refreshed store, not a per-request proxy (Bruce's standing rule,
 * 2026-09-23: when live doesn't serve, build the store yourself). BASE's own
 * legacy REST API resets every connection and IMPIC's current API needs
 * registration + a token Bruce has to request manually — this pack does
 * not wait on either; see the pack-level doc comment in src/index.ts.
 *
 * Loaded into a D1 database the gateway hands this pack as `_d1`
 * (pack-manifest "d1Binding": "PORTUGAL_TENDERS_DB") -- never by a deploy.
 * Loader: scripts/portugal-tenders/load-data.mjs.
 *
 * Kept OUT of the gateway bundle on purpose -- a full year of contracts
 * runs ~190k rows / ~340MB uncompressed JSON; any pack dataset over ~200 KB
 * belongs in a store, not an import (fleet #3060, same reasoning as
 * mcps/italy-tenders/src/store.ts).
 *
 * Plain LIKE-based filtering, no FTS5 (reference-d1-fts5-import-trap: an
 * FTS5 virtual table can arrive EMPTY through a chunked import with no
 * error). Search tools require a date range (defaulted, never unbounded) so
 * the LIKE scan runs over a narrowed slice rather than the full table.
 *
 * NOTE on placeholders: D1's local smoke shim mangles NUMBERED placeholders
 * (`?1`) -- every statement here uses plain, positional `?` (same convention
 * as mcps/italy-tenders/src/store.ts, mcps/asrs-reports/src/store.ts).
 *
 * KEYS: IMPIC's own `IdIncm` (announcement id) is not reliably unique --
 * a "-1" sentinel marks announcements published only in the Azores regional
 * gazette (JORAA), which never gets an INCM id, and several hundred of those
 * share the sentinel. `pt_announcement` therefore uses a synthetic
 * autoincrement `id` as its primary key; the loader wipes and reloads a
 * whole `ano` (year) at a time rather than upserting row-by-row, which is
 * safe because IMPIC republishes the FULL current-year file on every
 * refresh. `idcontrato` on contracts IS a usable natural key (99.5% unique,
 * confirmed live 2026-10-15 against the 2026 file) and is used as the
 * primary key there with INSERT OR REPLACE, same upsert pattern as Italy's
 * `cig`.
 */

export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      'portugal-tenders: the IMPIC/BASE tender store is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.',
    );
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

export const SOURCE = {
  source: 'IMPIC (Instituto dos Mercados Públicos, do Imobiliário e da Construção) — Portal BASE public-procurement register, open data via dados.gov.pt',
  source_url: 'https://dados.gov.pt/organizations/impic-i-p-instituto-dos-mercados-publicos-do',
  licence: 'Outra (Domínio Público) — "other-pd" (public domain), as published by dados.gov.pt. See README.md for the quoted licence field.',
};

export function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}

// ───────────────────────────── announcements ─────────────────────────────

export interface AnnouncementRow {
  id: number;
  id_incm: string | null;
  n_anuncio: string | null;
  tipo_acto: string | null;
  publication_date: string | null; // YYYY-MM-DD
  buyer_nif: string | null;
  buyer_name: string | null;
  title: string | null;
  url: string | null;
  tipos_contrato: string | null; // "; "-joined
  amount: number | null;
  cpv_codes: string | null; // ";"-joined bare CPV codes, for prefix search
  cpv_full: string | null; // "; "-joined "code - description"
  modelo_anuncio: string | null;
  ano: number | null;
  prazo_propostas: number | null;
  data_limite_propostas: string | null; // YYYY-MM-DD
  lotes: string | null; // "; "-joined
}

export function shapeAnnouncementSummary(r: AnnouncementRow) {
  return {
    id: r.id,
    id_incm: r.id_incm !== '-1' ? r.id_incm : null,
    n_anuncio: r.n_anuncio,
    title: r.title,
    buyer: r.buyer_name,
    tipo_acto: r.tipo_acto,
    tipos_contrato: r.tipos_contrato,
    amount_eur: r.amount,
    cpv: r.cpv_full,
    published: r.publication_date,
    offer_deadline: r.data_limite_propostas,
  };
}

export function shapeAnnouncementFull(r: AnnouncementRow) {
  return {
    id: r.id,
    id_incm: r.id_incm !== '-1' ? r.id_incm : null,
    n_anuncio: r.n_anuncio,
    title: r.title,
    buyer_nif: r.buyer_nif,
    buyer: r.buyer_name,
    tipo_acto: r.tipo_acto,
    tipos_contrato: r.tipos_contrato,
    modelo_anuncio: r.modelo_anuncio,
    amount_eur: r.amount,
    cpv: r.cpv_full,
    lotes: r.lotes,
    published: r.publication_date,
    offer_deadline: r.data_limite_propostas,
    offer_window_days: r.prazo_propostas,
    notice_url: r.url,
    year: r.ano,
  };
}

export interface AnnouncementFilters {
  terms: string[];
  cpv: string | null;
  buyer: string | null;
  dateFrom: string;
  dateTo: string;
  limit: number;
}

function buildAnnouncementWhere(f: AnnouncementFilters): { clause: string; args: unknown[] } {
  const clauses: string[] = ['publication_date >= ?', 'publication_date <= ?'];
  const args: unknown[] = [f.dateFrom, f.dateTo];
  for (const t of f.terms) {
    clauses.push('LOWER(title) LIKE ?');
    args.push(`%${t}%`);
  }
  if (f.cpv) {
    clauses.push('cpv_codes LIKE ?');
    args.push(`%${f.cpv}%`);
  }
  if (f.buyer) {
    clauses.push('LOWER(buyer_name) LIKE ?');
    args.push(`%${f.buyer}%`);
  }
  return { clause: clauses.join(' AND '), args };
}

export async function searchAnnouncements(db: D1Like, f: AnnouncementFilters): Promise<{ rows: AnnouncementRow[]; total: number }> {
  const { clause, args } = buildAnnouncementWhere(f);
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM pt_announcement WHERE ${clause}`)
    .bind(...args)
    .first<{ n: number }>();
  const total = Number(countRow?.n ?? 0);
  if (total === 0) return { rows: [], total: 0 };
  const { results } = await db
    .prepare(`SELECT * FROM pt_announcement WHERE ${clause} ORDER BY publication_date DESC LIMIT ?`)
    .bind(...args, f.limit)
    .all<AnnouncementRow>();
  return { rows: results, total };
}

export async function getAnnouncement(db: D1Like, id: number): Promise<AnnouncementRow | null> {
  return db.prepare('SELECT * FROM pt_announcement WHERE id = ?').bind(id).first<AnnouncementRow>();
}

// ───────────────────────────────── contracts ──────────────────────────────

export interface ContractRow {
  idcontrato: string;
  n_anuncio: string | null;
  tipo_anuncio: string | null;
  id_incm: string | null;
  tipo_contrato: string | null;
  id_procedimento: string | null;
  tipo_procedimento: string | null;
  title: string | null;
  description: string | null;
  buyer_nif: string | null;
  buyer_name: string | null;
  buyer_full: string | null;
  supplier_nif: string | null;
  supplier_name: string | null;
  supplier_full: string | null;
  publication_date: string | null;
  contract_date: string | null;
  amount: number | null;
  base_amount: number | null;
  total_effective_amount: number | null;
  cpv_codes: string | null;
  cpv_full: string | null;
  execution_days: number | null;
  location: string | null;
  procedure_centralized: string | null;
  decision_date: string | null;
  closing_date: string | null;
  regime: string | null;
  ano: number | null;
}

export function shapeContractSummary(r: ContractRow) {
  return {
    idcontrato: r.idcontrato,
    title: r.title,
    buyer: r.buyer_name,
    supplier: r.supplier_name,
    amount_eur: r.amount,
    tipo_contrato: r.tipo_contrato,
    cpv: r.cpv_full,
    published: r.publication_date,
    contract_date: r.contract_date,
  };
}

export function shapeContractFull(r: ContractRow) {
  return {
    idcontrato: r.idcontrato,
    n_anuncio: r.n_anuncio,
    tipo_anuncio: r.tipo_anuncio,
    id_incm: r.id_incm,
    tipo_procedimento: r.tipo_procedimento,
    tipo_contrato: r.tipo_contrato,
    title: r.title,
    description: r.description,
    buyer_nif: r.buyer_nif,
    buyer: r.buyer_name,
    buyer_all: r.buyer_full,
    supplier_nif: r.supplier_nif,
    supplier: r.supplier_name,
    supplier_all: r.supplier_full,
    amount_eur: r.amount,
    base_amount_eur: r.base_amount,
    total_effective_amount_eur: r.total_effective_amount,
    cpv: r.cpv_full,
    execution_days: r.execution_days,
    location: r.location,
    procedure_centralized: r.procedure_centralized,
    published: r.publication_date,
    contract_date: r.contract_date,
    decision_date: r.decision_date,
    closing_date: r.closing_date,
    regime: r.regime,
    year: r.ano,
  };
}

export interface ContractFilters {
  terms: string[];
  buyer: string | null;
  supplier: string | null;
  amountMin: number | null;
  amountMax: number | null;
  dateFrom: string;
  dateTo: string;
  limit: number;
}

function buildContractWhere(f: ContractFilters): { clause: string; args: unknown[] } {
  const clauses: string[] = ['publication_date >= ?', 'publication_date <= ?'];
  const args: unknown[] = [f.dateFrom, f.dateTo];
  for (const t of f.terms) {
    clauses.push('LOWER(title) LIKE ?');
    args.push(`%${t}%`);
  }
  if (f.buyer) {
    clauses.push('LOWER(buyer_name) LIKE ?');
    args.push(`%${f.buyer}%`);
  }
  if (f.supplier) {
    clauses.push('LOWER(supplier_name) LIKE ?');
    args.push(`%${f.supplier}%`);
  }
  if (f.amountMin != null) {
    clauses.push('amount >= ?');
    args.push(f.amountMin);
  }
  if (f.amountMax != null) {
    clauses.push('amount <= ?');
    args.push(f.amountMax);
  }
  return { clause: clauses.join(' AND '), args };
}

export async function searchContracts(db: D1Like, f: ContractFilters): Promise<{ rows: ContractRow[]; total: number }> {
  const { clause, args } = buildContractWhere(f);
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM pt_contract WHERE ${clause}`)
    .bind(...args)
    .first<{ n: number }>();
  const total = Number(countRow?.n ?? 0);
  if (total === 0) return { rows: [], total: 0 };
  const { results } = await db
    .prepare(`SELECT * FROM pt_contract WHERE ${clause} ORDER BY publication_date DESC LIMIT ?`)
    .bind(...args, f.limit)
    .all<ContractRow>();
  return { rows: results, total };
}

export async function getContract(db: D1Like, idcontrato: string): Promise<ContractRow | null> {
  return db.prepare('SELECT * FROM pt_contract WHERE idcontrato = ?').bind(idcontrato).first<ContractRow>();
}

// ──────────────────────────────────── meta ─────────────────────────────────

export interface Meta {
  data_as_of: string | null;
  ann_window_from: string | null;
  ann_window_to: string | null;
  contract_window_from: string | null;
  contract_window_to: string | null;
  years_loaded: string | null;
  total_announcements: number;
  total_contracts: number;
}

let cachedMeta: Meta | null = null;
export async function getMeta(db: D1Like): Promise<Meta> {
  if (cachedMeta) return cachedMeta;
  const rows = await db
    .prepare(
      "SELECT key, value FROM pt_meta WHERE key IN ('data_as_of','ann_window_from','ann_window_to','contract_window_from','contract_window_to','years_loaded')",
    )
    .all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  for (const r of rows.results) map[r.key] = r.value;
  const annCount = await db.prepare('SELECT COUNT(*) AS n FROM pt_announcement').first<{ n: number }>();
  const contractCount = await db.prepare('SELECT COUNT(*) AS n FROM pt_contract').first<{ n: number }>();
  cachedMeta = {
    data_as_of: map.data_as_of ?? null,
    ann_window_from: map.ann_window_from ?? null,
    ann_window_to: map.ann_window_to ?? null,
    contract_window_from: map.contract_window_from ?? null,
    contract_window_to: map.contract_window_to ?? null,
    years_loaded: map.years_loaded ?? null,
    total_announcements: Number(annCount?.n ?? 0),
    total_contracts: Number(contractCount?.n ?? 0),
  };
  return cachedMeta;
}
