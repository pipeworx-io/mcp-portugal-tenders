# @pipeworx/portugal-tenders

Portuguese public-procurement tender announcements and awarded contracts
from IMPIC (Instituto dos Mercados Públicos, do Imobiliário e da
Construção), Portugal's public-procurement regulator. Fleet #3111.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1808+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `pt_announcement_search(query?, cpv?, buyer?, date_from?, date_to?, limit?)`
  -- search tender announcements by free-text keyword (notice title), CPV
  classification code/prefix, contracting-authority (buyer) name substring,
  and a publish-date range (defaults to the last 90 days). Returns each
  notice's internal id, IMPIC notice id, buyer, title, notice type, contract
  type(s), base amount (EUR), CPV, publish date, and proposal deadline.
- `pt_announcement_detail(id)` -- the full record for one announcement by
  the internal id returned from `pt_announcement_search`, including the
  buyer's NIF tax number, procedure model, lot descriptions, and a link to
  the official notice document.
- `pt_contract_search(query?, buyer?, supplier?, amount_min?, amount_max?, date_from?, date_to?, limit?)`
  -- search awarded contracts by free-text keyword (contract title), buyer
  (adjudicante) name substring, awarded supplier (adjudicatário) name
  substring, a contract-amount range (EUR), and a publish-date range.
  Returns each contract's id, title, buyer, supplier, amount, contract
  type(s), CPV, publish date, and signing date.
- `pt_contract_detail(idcontrato)` -- the full record for one contract by
  its id, including buyer/supplier NIF tax numbers, full description, base
  procurement price, execution deadline and location(s), procedure type,
  and the legal regime cited.

Every response carries `source`, `source_url`, `licence`, `data_as_of`, and
(on search / no-match responses) the relevant `*_window_from`/`*_window_to`
pair -- the span this pack currently holds for that dataset -- so a caller
can tell "nothing on this topic" apart from "that date range isn't loaded".

## Auth

Keyless. The tools answer only through the Pipeworx gateway, which holds
the data; a standalone install has no data to read, and every tool
returns a clear "store is not bound in this runtime" error there instead
of an empty list.

## Data sources

- IMPIC (Instituto dos Mercados Públicos, do Imobiliário e da Construção)
  -- Portugal's public-procurement regulator, which runs the national
  tender register, Portal BASE. Fleet #3088 looked at reaching BASE
  directly and found two live paths, neither usable without more work:
  BASE's own legacy REST API resets every connection mid-response, and
  IMPIC's newer API needs account registration plus a token (Bruce ruled
  "register Portugal" on 2026-10-15 for that -- separate, ongoing, and this
  pack does not wait on it). IMPIC's own documentation says that newer API
  returns the SAME FIELDS as the files it already publishes as open data,
  organization IMPIC, on Portugal's national open-data portal
  (<https://dados.gov.pt/organizations/impic-i-p-instituto-dos-mercados-publicos-do>)
  -- one dataset of tender announcements and one of awarded contracts, each
  split into a file per calendar year, refreshed weekly. Because neither
  dataset offers server-side search, this pack builds a store from them
  (`scripts/portugal-tenders/load-data.mjs`) rather than proxying per
  request, per Bruce's standing rule (2026-09-23): when live doesn't serve,
  build the store yourself, with a refresh path and `data_as_of` on every
  response.

  **Licence (quoted verbatim from dados.gov.pt's own dataset API, checked
  live 2026-10-15):** both datasets report `"license": "other-pd"`,
  `"license_title": "Outra (Domínio Público)"` -- public domain, which
  explicitly permits reuse and redistribution. This is not a case the
  "mirror needs a reuse grant" rule (`mirror-needs-grant-proxy-does-not`,
  Bruce, 2026-09-08) holds for; the grant is already in the licence.
  Attribution is carried in every response's `source`/`source_url` fields.

### Known gaps -- read before extending this pack

**This pack holds a ROLLING TWO-YEAR WINDOW (current + previous calendar
year), not IMPIC's full 2012-2026 history.** A full year of awarded
contracts alone runs ~190,000 rows / ~340MB of uncompressed JSON (measured
live for the partial 2026 year, 2026-10-15); fifteen years of that would run
into the GBs, dwarfing what one pack's D1 database should carry.
`pt_announcement_search` / `pt_contract_search` report their loaded window
(`ann_window_from`/`ann_window_to`, `contract_window_from`/
`contract_window_to`) on every no-match response, so a caller can tell a
genuinely empty result apart from a date outside what is loaded.

**No accent/diacritic folding on `buyer` / `supplier` / `query` filters.**
A search for `buyer: "camara"` will NOT match "Câmara Municipal de Lisboa"
-- the match is a plain case-insensitive substring, and "a" is not treated
as equivalent to "â"/"ã". Searching with the accented spelling (as IMPIC
records it) works. Fixable later with a normalized/folded column if this
turns out to cost real matches.

**IMPIC's own announcement id (`IdIncm`) is not reliably unique** -- a
"-1" sentinel marks notices published only through a regional gazette
(e.g. the Azores' JORAA) rather than through Diário da República, and
several hundred share that sentinel within a single year. `pt_announcement_detail`
therefore keys on a synthetic internal id this pack assigns, returned as
`id` from `pt_announcement_search`, not on `IdIncm` itself (which is still
returned, for reference, and is `null` in the response whenever the
underlying value is the "-1" sentinel).

**Only announcements and awarded contracts are built.** IMPIC also
publishes a contract-amendments dataset and a buyer-directory dataset on
the same open-data portal; not built here, to keep this pack's scope to
what fleet #3111 asked for (announcement search, contract search, detail).
A later change can add either without touching the schema above.

### Refreshing the data

`node scripts/portugal-tenders/load-data.mjs --years 2025,2026 [--retain-from-year 2025] [--init-schema on the very first run]`
-- resolves each requested year's announcement and contract resource LIVE
through dados.gov.pt's own dataset API (never a hard-coded dated path --
the underlying storage URL carries a timestamp segment that changes on
every weekly IMPIC refresh), downloads and streams them, and loads D1:
announcements wipe-and-reload a whole year at a time (no reliable natural
key -- see "Known gaps"); contracts upsert (`INSERT OR REPLACE`) keyed by
`idcontrato`, so re-loading a year already present just refreshes rows
IMPIC updated. Needs `wrangler` logged in to the Pipeworx Cloudflare
account and the `unzip` CLI.

The GitHub workflow `.github/workflows/portugal-tenders-refresh.yml` runs
this weekly, re-pulling the current and previous calendar year and rolling
`--retain-from-year` so the table does not grow without bound.

### Pre-deploy smoke testing (no production D1 needed)

```
node --experimental-strip-types scripts/portugal-tenders/build-local-sqlite.mjs \
  --year 2026 --ann <a downloaded anuncios2026.json> --contract <its extracted Contratos2026.json> \
  --out /tmp/portugal-tenders.sqlite
node --experimental-strip-types scripts/portugal-tenders/smoke-local.mjs /tmp/portugal-tenders.sqlite
```

Exercises the pack's real `callTool()` against a local SQLite file built
from real IMPIC year files via a `D1Like` adapter -- same shape as
`scripts/italy-tenders/{build-local-sqlite,smoke-local}.mjs`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "portugal-tenders": {
      "url": "https://gateway.pipeworx.io/portugal-tenders/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/portugal-tenders/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1808+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/pt_announcement_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"seguros","date_from":"2026-01-01","date_to":"2026-01-31","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/pt_announcement_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "portugal-tenders": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-portugal-tenders"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-portugal-tenders
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Portugal Tenders data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
