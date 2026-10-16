<div align="center">
  <h1>@cyanheads/fema-mcp-server</h1>
  <p><b>Query FEMA disaster declarations, public assistance grants, housing aid, and NFIP flood insurance claims via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 1 Opt-in Tool • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/fema-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/fema-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/fema-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/fema-mcp-server/releases/latest/download/fema-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=fema-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmVtYS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22fema-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffema-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://fema.caseyjhand.com/mcp](https://fema.caseyjhand.com/mcp)

</div>

---

## Overview

Federal disaster recovery data from FEMA: disaster declarations, public assistance grants, individual housing assistance, and NFIP flood insurance claims. Search declarations by state or incident, see the public and housing assistance behind any disaster, and run SQL over large flood-claim result sets.

### Tools

| Tool | Description |
|:---|:---|
| `fema_search_disasters` | Search federal disaster declarations by state, incident type, declaration type, date range, and county |
| `fema_get_disaster` | Fetch all designated-area records for a specific disaster by disaster number |
| `fema_get_public_assistance` | Public assistance funded projects for a disaster or state — where federal recovery money went |
| `fema_get_housing_assistance` | Individual assistance housing data for a disaster — owner and renter breakdowns and inspection counts by county/ZIP, filterable by county or ZIP |
| `fema_search_nfip` | NFIP flood insurance claims for a state, county, or ZIP, with optional DataCanvas spillover for SQL analytics |
| `fema_dataframe_describe` | List columns and row counts for DataCanvas tables staged by `fema_search_nfip` |
| `fema_dataframe_query` | Run a SELECT query against a DataCanvas table staged by `fema_search_nfip` |
| `fema_dataframe_drop` | Remove a staged DataCanvas table or view — opt-in, absent from `tools/list` by default |
| `fema_query_dataset` | Generic OData query against any dataset in the OpenFEMA catalog — escape hatch for datasets the convenience tools don't cover |

`fema_dataframe_drop` is callable and appears in `tools/list` only when `FEMA_ENABLE_CANVAS_DROP=true`. Its definition is always included in `createApp()`; while disabled, the HTTP landing page displays the enable hint. The other eight tools are always advertised.

### Resources

| Resource | Description |
|:---|:---|
| `fema://disaster/{disasterNumber}` | Summary for a specific FEMA disaster declaration — title, state, incident type, programs, incident period |

All resource data is also reachable via tools. Use `fema_get_disaster` for the same data with full designated-area detail.

## Capability reference

### `fema_search_disasters` <sub>tool</sub>

- Filters: `state`, `incident_type`, `declaration_type` (`DR`/`EM`/`FM`), inclusive `date_from`/`date_to` (`YYYY-MM-DD`; equal dates select one day), and `county`; page with `limit` (1–1000, default 50) and `offset`. A page stops at 100,000 characters of declarations; `next_offset` names where the next page starts.
- `incident_type` and `county` are case-insensitive substring matches: `storm` also matches `Snowstorm`, `harris` matches `Harris` and `Harrison`, `dekalb` matches `DeKalb`. Blank values are ignored.
- Returns one summary per disaster number with `designated_area_count`, program flags, and declaration totals. `county` selects declarations without narrowing those: the count and flags describe the whole declaration, `total_area_rows` counts the matched area rows, and `matched_areas` lists each matched area with its FIPS codes and its own flags (an area designated for PA and HM only has `ia_declared: false`). Typed errors: `invalid_state`, `invalid_range` (`date_from` after `date_to`), `no_results`, `request_too_long`.
- Searches the most recent 10,000 designated-area rows. When capped, returns complete declarations, marks `truncated`, reports declaration totals as lower bounds, and names the next `date_to` in `notice`.

---

### `fema_get_disaster` <sub>tool</sub>

- Requires `disaster_number` from `fema_search_disasters`.
- Returns all designated-area records, FIPS codes, incident period, and program flags combined across areas; a missing disaster returns `not_found`.

---

### `fema_get_public_assistance` <sub>tool</sub>

- Requires `disaster_number` or `state`; optional `county` filter (case-insensitive substring), `limit` (1–10000, default 100), and `offset`. A page stops at 100,000 characters of projects; `next_offset` names where the next page starts.
- Returns applicants, damage categories, project size/status, and federal and total obligations. Typed errors: `invalid_state`, `missing_filter`, `not_found`, `no_results`, `request_too_long`.

---

### `fema_get_housing_assistance` <sub>tool</sub>

- Requires `disaster_number`; optional `state`, `county` (case-insensitive substring), `zip_code` (5 digits, leading zeros kept), `type` (`owners`/`renters`/`both`, default `both`), `limit` (1–10000, default 100), and `offset`. The filters apply to both datasets before paging, so `owners_count`, `renters_count`, and `offset` count the filtered records. A page stops at 100,000 characters of rows, cutting owners and renters at the same count, so one `next_offset` continues both.
- Returns separate `owners` and `renters` arrays with county/ZIP registrations, approved amounts, and inspection counts, plus `owners_count`/`renters_count` totals. Owners also carry inspected damage in USD; an owner area nobody inspected reads as uninspected, not as $0 of damage. Renters carry damage-degree counts of registrations and no dollar damage. Typed errors: `invalid_state`, `not_found`, `no_results`, `request_too_long`.

---

### `fema_search_nfip` <sub>tool</sub>

- Requires `state`; optional `county_code`, `zip_code`, `year_from`/`year_to`, `limit` (1–10000, default 1000), and `offset`. Reads `NfipClaims` v3, newest loss first with claim ID breaking ties.
- `county_code` accepts a full 5-digit FIPS code (e.g., `48201`) or a 3-digit county code (e.g., `201`); the server prefixes the latter with the state's FIPS code. A shorter county code is zero-padded to 3 digits, and a 4-digit code to 5 (`1001` → `01001`, the form a numeric `01001` arrives in). A 5-digit code from another state is still sent, and an empty match names the mismatch.
- Inline claims stop at 100,000 characters, with the continuation in `next_offset` and `notice`; `cause_of_damage` and `occupancy_type` retain OpenFEMA's published codes. Typed errors: `invalid_state`, `invalid_county_code` (anything but 1–5 digits, or a short code for FM, MH, or PW), `invalid_range` (`year_from` after `year_to`), `no_results`.
- With `CANVAS_PROVIDER_TYPE=duckdb`, a first-page match exceeding the inline budget stages up to 50,000 rows. `canvas_id`, `canvas_table`, and `staged_count` identify the stage; `truncated: true` marks its cap and `total_count` retains the full match. Inspect the stage with `fema_dataframe_describe`, then query it with `fema_dataframe_query`.

---

### `fema_dataframe_describe` <sub>tool</sub>

- Requires `canvas_id` from `fema_search_nfip`.
- Lists table/view names, column types, nullability, and staged row counts. Typed errors: `canvas_not_found`, `canvas_unavailable`.

---

### `fema_dataframe_query` <sub>tool</sub>

- Requires `canvas_id` and a single SQL `query`; only SELECT statements are permitted. DDL, DML, COPY, and file-reading functions are blocked.
- Returns rows capped at the canvas row limit and at 100,000 characters, with `truncated`/`shown` and OFFSET guidance when either cut the result (`cap` only when the row limit did). Typed errors: `canvas_unavailable`, `canvas_not_found`, `missing_table`, `invalid_sql`, `non_select_statement`, `multi_statement`, `denied_function`, `plan_operator_not_allowed`, `sql_read_only`, `sql_execution_error` (use `TRY_CAST` or filter incompatible values).

---

### `fema_dataframe_drop` <sub>tool</sub>

- Requires `canvas_id` and the exact `table_name` from `fema_dataframe_describe`.
- Removes one staged table or view; `dropped: false` means the name did not exist. Typed errors: `canvas_not_found`, `canvas_unavailable`.
- Opt-in through `FEMA_ENABLE_CANVAS_DROP=true`; disabled by default with an enable hint in the manifest. FEMA source data is unchanged.

---

### `fema_query_dataset` <sub>tool</sub>

- Requires a case-sensitive OpenFEMA `dataset`; optional OData `filter`/`select`/`orderby`, `limit` (1–10000, default 100), and `offset`. Resolves each dataset's API version from the catalog. A page stops at 100,000 characters of records; `next_offset` names where the next page starts.
- Returns records and `total_count`; an empty page succeeds with filter or paging guidance. Typed errors: `unknown_dataset`, `dataset_not_served`, `catalog_unavailable` (retryable), `invalid_filter`, `invalid_select`, `invalid_orderby`, `invalid_odata_syntax`, `request_too_long` (URL past about 8,900 characters), `filter_too_complex` (filter nested more than 100 levels deep).
- For a list of values, use `field in ('a','b')` rather than a chain of `or` comparisons; OpenFEMA's nesting limit allows about 90 chained comparisons.
- For `NfipPolicies`, use `propertyState` and `reportedZipCode`; always include a ZIP filter to avoid timeout.

---

### `fema://disaster/{disasterNumber}` <sub>resource</sub>

- Requires `disasterNumber` as a string of digits.
- Returns title, state, incident type, declaration type/date, incident period, `programs_declared`, and `designated_area_count`; `not_found` carries recovery guidance pointing to `fema_search_disasters`.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

OpenFEMA-specific:

- Disaster numbers are in OpenFEMA's range 1–32767; an offset past the last match returns an empty page with totals and a notice naming the last valid offset.
- Canvas inputs accept the server-issued 10-character URL-safe `canvas_id` (`[A-Za-z0-9_-]{10}`); omit it on the first NFIP search.
- Typed OpenFEMA REST client with `%24`-prefixed OData parameter encoding (an Akamai requirement), per-dataset API versions resolved from the OpenFEMA dataset catalog, and structured error classification distinguishing JSON 400 responses (by the failing `filter`/`select`/`orderby` clause) from HTML Drupal error pages and the CDN's refusal of over-long URLs
- Case-insensitive name filters over OpenFEMA's case-sensitive `substringof`: a caller's county or incident type resolves to the exact-case spellings stored in a bundled snapshot of `DisasterDeclarationsSummaries` names, plus lower/UPPER/Title variants, in the same single request. Refresh the snapshot with `bun run vocabulary:build`
- Automatic deduplication of `DisasterDeclarationsSummaries` — one row per designated area collapsed to declaration-level summaries with `designated_area_count`; a county search reads the returned declarations' full area rows so the count and program flags stay declaration-level
- NFIP Claims guard: `state` filter is required to prevent unbounded 2.7M-row fetches
- DataCanvas spillover for NFIP analytics — large NFIP result sets materialize as DuckDB tables queryable via SQL without re-fetching
- No API keys required — OpenFEMA is a free, public API

Agent-friendly output:

- Disaster number is the explicit join key across all datasets — every tool that touches a disaster surfaces it prominently so agents can chain calls without re-searching
- Typed error contracts on every tool — `invalid_state`, `invalid_county_code`, `invalid_range`, `no_results`, `not_found`, `missing_filter`, `unknown_dataset`, `dataset_not_served`, `invalid_filter`, `invalid_select`, `invalid_orderby`, `invalid_odata_syntax`, `request_too_long`, `filter_too_complex`, `canvas_unavailable` — with recovery hints telling agents the concrete next step
- `designated_area_count` on search results so agents know whether to drill in with `fema_get_disaster` without having to fetch the full record first

## Getting started

### Public Hosted Instance

A public instance is available at `https://fema.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "fema-mcp-server": {
      "type": "streamable-http",
      "url": "https://fema.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "fema-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/fema-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "fema-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/fema-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "fema-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/fema-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

To enable DuckDB-backed SQL analytics for NFIP Claims:

```json
{
  "mcpServers": {
    "fema-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/fema-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "CANVAS_PROVIDER_TYPE": "duckdb"
      }
    }
  }
}
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API keys required — OpenFEMA is a free, public API.
- Optional: set `CANVAS_PROVIDER_TYPE=duckdb` to enable SQL analytics over large NFIP Claims result sets.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/fema-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd fema-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env — no required vars, but CANVAS_PROVIDER_TYPE=duckdb enables SQL analytics
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---------|:------------|:--------|
| `FEMA_BASE_URL` | Override the OpenFEMA API root. Each dataset's version is appended per request; a trailing `/v<N>` segment is ignored. | `https://www.fema.gov/api/open` |
| `FEMA_REQUEST_TIMEOUT_MS` | Total budget in milliseconds for one upstream exchange, including response body, retries, and backoff. NFIP county queries can be slow. | `30000` |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas for NFIP Claims analytics. Without it, `fema_search_nfip` returns inline pages only, paged by `offset`. | — |
| `FEMA_ENABLE_CANVAS_DROP` | Enable the destructive `fema_dataframe_drop` tool for removing staged tables and views. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | Session mode: `auto`, `stateful`, or `stateless`. Overrides this server's explicit stateless default. The framework schema default `auto` resolves to stateful. | `stateless` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed-call arguments and results, redacted by key name. Secrets in free-form values are retained. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | Per-payload UTF-8 byte cap for failed-call logging. | `16384` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base URL; traces append `/v1/traces`, metrics append `/v1/metrics`. | — |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Override the traces endpoint; used as-is. | — |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Override the metrics endpoint; used as-is. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt into log export at this URL; the base endpoint alone never enables it. | — |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t fema-mcp-server .
docker run --rm -e MCP_TRANSPORT_TYPE=stdio fema-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/fema-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them. Production dependencies are cross-installed for the target architecture in a native build stage, with release-age and Socket checks; the Debian runtime excludes unused musl bindings.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — one file per tool. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/openfema` | OpenFEMA REST API client — OData param builder, response parser, error classifier, retry wrapper — plus the case-insensitive name matcher and its bundled name vocabulary. |
| `src/services/canvas` | DataCanvas integration — DuckDB spillover for large NFIP result sets. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## Data source

Data is provided by the [OpenFEMA API](https://www.fema.gov/about/openfema/api), a free public API maintained by the Federal Emergency Management Agency. Usage is subject to [OpenFEMA Terms and Conditions](https://www.fema.gov/about/openfema/terms-conditions).

> This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA. The Federal Government or FEMA cannot vouch for the data or analyses derived from these data after the data have been retrieved from the Agency's website(s).

When citing OpenFEMA datasets in research or publications, use the format FEMA specifies:

```
Federal Emergency Management Agency (FEMA), OpenFEMA Dataset: <name>. Retrieved from <URL> on <date>.
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
