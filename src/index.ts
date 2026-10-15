interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}
/**
 * Portugal public procurement MCP -- IMPIC (Instituto dos Mercados Públicos,
 * do Imobiliário e da Construção), Portugal's public-procurement regulator,
 * via its open-data publication on dados.gov.pt.
 *
 * SOURCE: IMPIC runs the national tender register, Portal BASE
 * (base.gov.pt). Fleet #3088 dropped Portugal because BASE's legacy REST
 * API resets every connection and IMPIC's current API needs registration
 * plus a token Bruce has to request manually (fleet #3111 note: "register
 * Portugal", ruled 2026-10-15 -- not wired up yet, and this pack does not
 * wait on it). IMPIC's own docs ("Formas de obter dados" on base.gov.pt)
 * say its API returns the SAME FIELDS as the files it publishes as open
 * data at dados.gov.pt (organization IMPIC) -- keyless, licensed
 * "other-pd" (public domain), refreshed weekly. This pack reads those
 * files instead of either BASE API, per Bruce's standing rule (2026-09-23):
 * when live doesn't serve, build the store yourself, with a refresh path
 * and data_as_of on every response. See src/store.ts for how the data is
 * held (D1, loaded by scripts/portugal-tenders/load-data.mjs -- never a
 * bundled import).
 *
 * TWO DATASETS, two tool pairs:
 *  - "anuncios<year>.json" -- tender ANNOUNCEMENTS (one per publication in
 *    Diário da República or a regional gazette): pt_announcement_search /
 *    pt_announcement_detail.
 *  - "Contratos<year>.json" (inside a yearly .zip) -- awarded CONTRACTS:
 *    pt_contract_search / pt_contract_detail.
 * A later change can add the "modificacoes-contratuais" (contract
 * amendments) and "entidades" (buyer directory) datasets IMPIC also
 * publishes; not built here to keep this pack's scope to what fleet #3111
 * asked for.
 *
 * WINDOW: a rolling TWO-YEAR window (current + previous calendar year), not
 * IMPIC's full 2012-2026 history -- see README.md "Known gaps" for exactly
 * which years are loaded. A full year of contracts alone runs ~190k rows /
 * ~340MB uncompressed JSON (measured live for 2026, 2026-10-15); the full
 * 2012-present history would run into the GBs, dwarfing what one pack's D1
 * database should carry.
 *
 * KEY RESOLUTION, never hard-coded dated paths: each year's resource is
 * resolved live through dados.gov.pt's dataset API
 * (GET https://dados.gov.pt/api/1/datasets/<slug>/, matched by resource
 * title) rather than a fixed URL, because the underlying storage path
 * carries a timestamp segment that changes on every weekly refresh -- see
 * scripts/portugal-tenders/pt-data-utils.mjs `resolveResource()`.
 *
 * LICENCE: dados.gov.pt's own dataset API reports
 * `"license": "other-pd"`, `"license_title": "Outra (Domínio Público)"` for
 * every IMPIC/BASE dataset this pack uses (confirmed live, 2026-10-15) --
 * public domain, which explicitly permits redistribution. Quoted in full in
 * README.md.
 *
 * All tools return shaped, LLM-friendly objects (never raw upstream JSON
 * passthrough) and never throw -- fetch/parse failures resolve to
 * { error, retry_hint }.
 */

import {
  requireDb,
  getMeta,
  getAnnouncement,
  getContract,
  searchAnnouncements,
  searchContracts,
  shapeAnnouncementFull,
  shapeAnnouncementSummary,
  shapeContractFull,
  shapeContractSummary,
  isValidDate,
  SOURCE,
} from './store.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_WINDOW_DAYS = 90; // IMPIC publishes per-YEAR files, so "recent" means the newest loaded data, not the newest day

function capped(limit: unknown, fallback = DEFAULT_LIMIT, max = MAX_LIMIT): number {
  const n = typeof limit === 'number' ? limit : typeof limit === 'string' && limit.trim() && Number.isFinite(Number(limit)) ? Number(limit) : fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  return undefined;
}

function numArg(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function intArg(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isInteger(Number(v))) return Number(v);
  return undefined;
}

function today(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Resolves a default [date_from, date_to] pair anchored on the END OF THE
 *  LOADED WINDOW, not today -- IMPIC publishes per-year files and this
 *  pack's freshest row can trail today (italy-tenders fix 0788f7d4f: a
 *  today-anchored default can search a range holding no data and answer
 *  found:false even though the pack is current). */
function defaultRange(dateFromRaw: string | undefined, dateToRaw: string | undefined, windowTo: string | null): { dateFrom: string; dateTo: string } | { error: string } {
  if (dateToRaw && !isValidDate(dateToRaw)) return { error: 'user_error: date_to must be YYYY-MM-DD.' };
  if (dateFromRaw && !isValidDate(dateFromRaw)) return { error: 'user_error: date_from must be YYYY-MM-DD.' };
  const windowEnd = typeof windowTo === 'string' && isValidDate(windowTo) ? windowTo : null;
  const dateTo = dateToRaw ?? (windowEnd && windowEnd < today() ? windowEnd : today());
  const dateFrom = dateFromRaw ?? addDays(dateTo, -DEFAULT_WINDOW_DAYS);
  if (dateFrom > dateTo) return { error: 'user_error: date_from must be on or before date_to.' };
  return { dateFrom, dateTo };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'pt_announcement_search',
    description:
      'Search PORTUGUESE public-procurement tender ANNOUNCEMENTS (contract notices) published through Portal BASE (base.gov.pt), run by IMPIC (Instituto dos Mercados Públicos, do Imobiliário e da Construção). IMPIC\'s own live API needs registration and a token Pipeworx does not hold yet, so this answers from a refreshed recent-window dataset (see data_as_of and the window fields in the response). Filter by free-text keyword (matched against the Portuguese notice title), CPV classification code or prefix (e.g. "45" for construction, "72000000" for IT services), contracting-authority (buyer) name substring (Portuguese spelling, e.g. "Câmara Municipal", "Instituto"), and a publish-date range. Returns compact shaped notices: id, IMPIC notice id, buyer, title, notice type, contract type(s), base amount (EUR), CPV, publish date, and proposal deadline. Call pt_announcement_detail with the returned id for the full record.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword(s), case-insensitive, matched against the Portuguese notice title, e.g. "limpeza", "software", "obras", "manutenção".' },
        cpv: { type: 'string', description: 'CPV classification code or numeric prefix, e.g. "45" (construction works), "72000000" (IT services).' },
        buyer: { type: 'string', description: 'Contracting-authority (buyer) name, partial match, Portuguese spelling, e.g. "Câmara Municipal de Lisboa", "Instituto", "Universidade".' },
        date_from: { type: 'string', description: `Earliest PUBLISH date, YYYY-MM-DD. Defaults to ${DEFAULT_WINDOW_DAYS} days before date_to.` },
        date_to: { type: 'string', description: 'Latest PUBLISH date, YYYY-MM-DD. Defaults to the newest date in the loaded window (see ann_window_to in any response), which can trail today because IMPIC publishes per-year bulk files.' },
        limit: { type: ['number', 'string'], description: `Max notices to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Newest-first.` },
      },
    },
  },
  {
    name: 'pt_announcement_detail',
    description:
      'Fetch one PORTUGUESE tender announcement by the internal "id" returned from pt_announcement_search. Returns the full record: IMPIC notice id, buyer (with NIF tax number), notice type, contract type(s), procedure model, base amount, CPV codes, lot descriptions, publish date, proposal deadline and window, and a link to the official notice document.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'The announcement\'s internal id, from pt_announcement_search.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'pt_contract_search',
    description:
      'Search PORTUGUESE public-procurement AWARDED CONTRACTS published through Portal BASE (base.gov.pt), run by IMPIC. Filter by free-text keyword (matched against the Portuguese contract title), buyer (adjudicante/contracting-authority) name substring, supplier (adjudicatário/awarded contractor) name substring, contract-amount range (EUR), and a publish-date range. Returns compact shaped contracts: contract id, title, buyer, supplier, amount (EUR), contract type(s), CPV, publish date, and the contract-signing date. Call pt_contract_detail with the returned idcontrato for the full record.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword(s), case-insensitive, matched against the Portuguese contract title, e.g. "pavimentação", "formação", "software".' },
        buyer: { type: 'string', description: 'Contracting-authority (buyer/adjudicante) name, partial match, Portuguese spelling, e.g. "Câmara Municipal do Porto", "Ministério".' },
        supplier: { type: 'string', description: 'Awarded supplier (adjudicatário) name, partial match, e.g. "Mota-Engil", "Altice".' },
        amount_min: { type: ['number', 'string'], description: 'Minimum contract amount in EUR.' },
        amount_max: { type: ['number', 'string'], description: 'Maximum contract amount in EUR.' },
        date_from: { type: 'string', description: `Earliest PUBLISH date, YYYY-MM-DD. Defaults to ${DEFAULT_WINDOW_DAYS} days before date_to.` },
        date_to: { type: 'string', description: 'Latest PUBLISH date, YYYY-MM-DD. Defaults to the newest date in the loaded window (see contract_window_to in any response).' },
        limit: { type: ['number', 'string'], description: `Max contracts to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Newest-first.` },
      },
    },
  },
  {
    name: 'pt_contract_detail',
    description:
      'Fetch one PORTUGUESE awarded contract by its "idcontrato" (returned from pt_contract_search). Returns the full record: buyer and supplier (with NIF tax numbers), full title and description, amount, base procurement price, CPV codes, execution deadline, execution location(s), procedure type, publish/signing/decision dates, and the legal regime cited.',
    inputSchema: {
      type: 'object',
      properties: {
        idcontrato: { type: 'string', description: 'The contract\'s id, e.g. "12026866". Returned by pt_contract_search.' },
      },
      required: ['idcontrato'],
    },
  },
];

function noMatch(hint: string, extra?: Record<string, unknown>) {
  return { found: false, reason: 'no_match', hint, ...SOURCE, ...extra };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'pt_announcement_search': {
        const db = requireDb(args._d1);
        const meta = await getMeta(db);
        const range = defaultRange(strArg(args.date_from), strArg(args.date_to), meta.ann_window_to);
        if ('error' in range) return range;
        const { dateFrom, dateTo } = range;

        const queryRaw = strArg(args.query);
        const terms = queryRaw ? queryRaw.toLowerCase().split(/\s+/).filter(Boolean) : [];
        const cpv = strArg(args.cpv) ?? null;
        const buyer = strArg(args.buyer)?.toLowerCase() ?? null;
        const limit = capped(args.limit);

        const { rows, total } = await searchAnnouncements(db, { terms, cpv, buyer, dateFrom, dateTo, limit });
        if (!total) {
          return noMatch(
            `No announcement matched between ${dateFrom} and ${dateTo}. This pack holds a recent rolling window (${meta.ann_window_from ?? '?'}..${meta.ann_window_to ?? '?'}), not IMPIC's full 2012-present history -- try a date range inside that window, or broaden the keyword/buyer/CPV filter.`,
            { date_from: dateFrom, date_to: dateTo, ann_window_from: meta.ann_window_from, ann_window_to: meta.ann_window_to, data_as_of: meta.data_as_of },
          );
        }
        return {
          found: true,
          date_from: dateFrom,
          date_to: dateTo,
          returned: rows.length,
          total_matching: total,
          truncated: total > rows.length,
          announcements: rows.map(shapeAnnouncementSummary),
          ann_window_from: meta.ann_window_from,
          ann_window_to: meta.ann_window_to,
          data_as_of: meta.data_as_of,
          ...SOURCE,
        };
      }

      case 'pt_announcement_detail': {
        const db = requireDb(args._d1);
        const meta = await getMeta(db);
        const id = intArg(args.id);
        if (id == null) return { error: 'pt_announcement_detail requires a numeric "id" -- get one from pt_announcement_search.' };
        const row = await getAnnouncement(db, id);
        if (!row) {
          return noMatch(`No announcement with id ${id} in this pack's loaded window (${meta.ann_window_from ?? '?'}..${meta.ann_window_to ?? '?'}). Get an id from pt_announcement_search.`, {
            ann_window_from: meta.ann_window_from,
            ann_window_to: meta.ann_window_to,
            data_as_of: meta.data_as_of,
          });
        }
        return { found: true, ...shapeAnnouncementFull(row), data_as_of: meta.data_as_of, ...SOURCE };
      }

      case 'pt_contract_search': {
        const db = requireDb(args._d1);
        const meta = await getMeta(db);
        const range = defaultRange(strArg(args.date_from), strArg(args.date_to), meta.contract_window_to);
        if ('error' in range) return range;
        const { dateFrom, dateTo } = range;

        const queryRaw = strArg(args.query);
        const terms = queryRaw ? queryRaw.toLowerCase().split(/\s+/).filter(Boolean) : [];
        const buyer = strArg(args.buyer)?.toLowerCase() ?? null;
        const supplier = strArg(args.supplier)?.toLowerCase() ?? null;
        const amountMin = numArg(args.amount_min) ?? null;
        const amountMax = numArg(args.amount_max) ?? null;
        if (amountMin != null && amountMax != null && amountMin > amountMax) return { error: 'user_error: amount_min must be <= amount_max.' };
        const limit = capped(args.limit);

        const { rows, total } = await searchContracts(db, { terms, buyer, supplier, amountMin, amountMax, dateFrom, dateTo, limit });
        if (!total) {
          return noMatch(
            `No contract matched between ${dateFrom} and ${dateTo}. This pack holds a recent rolling window (${meta.contract_window_from ?? '?'}..${meta.contract_window_to ?? '?'}), not IMPIC's full 2012-present history -- try a date range inside that window, or broaden the keyword/buyer/supplier/amount filter.`,
            { date_from: dateFrom, date_to: dateTo, contract_window_from: meta.contract_window_from, contract_window_to: meta.contract_window_to, data_as_of: meta.data_as_of },
          );
        }
        return {
          found: true,
          date_from: dateFrom,
          date_to: dateTo,
          returned: rows.length,
          total_matching: total,
          truncated: total > rows.length,
          contracts: rows.map(shapeContractSummary),
          contract_window_from: meta.contract_window_from,
          contract_window_to: meta.contract_window_to,
          data_as_of: meta.data_as_of,
          ...SOURCE,
        };
      }

      case 'pt_contract_detail': {
        const db = requireDb(args._d1);
        const meta = await getMeta(db);
        const idcontrato = strArg(args.idcontrato);
        if (!idcontrato) return { error: 'pt_contract_detail requires "idcontrato" -- get one from pt_contract_search.' };
        const row = await getContract(db, idcontrato);
        if (!row) {
          return noMatch(`No contract with idcontrato "${idcontrato}" in this pack's loaded window (${meta.contract_window_from ?? '?'}..${meta.contract_window_to ?? '?'}). Get an idcontrato from pt_contract_search.`, {
            contract_window_from: meta.contract_window_from,
            contract_window_to: meta.contract_window_to,
            data_as_of: meta.data_as_of,
          });
        }
        return { found: true, ...shapeContractFull(row), data_as_of: meta.data_as_of, ...SOURCE };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const { token, body } = splitClassPrefix(raw);
    return {
      error: `${token}portugal-tenders: ${body}`,
      retry_hint: 'Retry once; if it persists the IMPIC/BASE tender store may be temporarily unavailable.',
    };
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
