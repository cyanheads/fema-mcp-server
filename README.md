<div align="center">
  <h1>@cyanheads/fema-mcp-server</h1>
  <p><b>Query FEMA disaster declarations, public assistance grants, housing aid, and NFIP flood insurance claims via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 1 Opt-in Tool • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/fema-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/fema-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/fema-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Federal disaster recovery data from FEMA's OpenFEMA API — disaster declarations, public assistance grants, individual housing assistance, and NFIP flood insurance claims. Search declarations by state or incident, drill into public assistance and housing assistance by disaster number, and run SQL analytics over large NFIP result sets via DataCanvas. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `fema_search_disasters` | Search federal disaster declarations by state, incident type, declaration type, date range, and county |
| `fema_get_disaster` | Fetch all designated-area records for a specific disaster by disaster number |
| `fema_get_public_assistance` | Public assistance funded projects for a disaster or state — where federal recovery money went |
| `fema_get_housing_assistance` | Individual assistance housing data for a disaster — owner and renter breakdowns by county/ZIP |
| `fema_search_nfip` | NFIP flood insurance claims for a state, county, or ZIP, with optional DataCanvas spillover for SQL analytics |
| `fema_dataframe_describe` | List columns and row counts for DataCanvas tables staged by `fema_search_nfip` |
| `fema_dataframe_query` | Run a SELECT query against a DataCanvas table staged by `fema_search_nfip` |
| `fema_dataframe_drop` | Remove a staged DataCanvas table or view — opt-in, absent from `tools/list` by default |
| `fema_query_dataset` | Generic OData query against any OpenFEMA v2 dataset — escape hatch for datasets the convenience tools don't cover |

`fema_dataframe_drop` is registered only when `FEMA_ENABLE_CANVAS_DROP=true`; the other eight tools are always advertised.

### Resources

| Resource | Description |
|:---|:---|
| `fema://disaster/{disasterNumber}` | Summary for a specific FEMA disaster declaration — title, state, incident type, programs, incident period |

All resource data is also reachable via tools. Use `fema_get_disaster` for the same data with pagination and full designated-area detail.

## Capability reference

### `fema_search_disasters` <sub>tool</sub>

- Filters: `state` (2-letter code), `incident_type` (substring match), `declaration_type` (`DR`/`EM`/`FM`), `date_from`/`date_to` (declaration date range), `county` (substring); paginated via `limit` (1–1000, default 50) / `offset`
- Returns deduplicated declaration-level summaries — one row per unique disaster number, with `designated_area_count` and program flags (`ia_declared`/`pa_declared`/`hm_declared`)
- Deduplicates the most recent 10,000 designated-area rows before paging; when `total_area_rows` exceeds 10,000, unique-declaration totals are lower bounds
- Typed errors: `invalid_state`, `no_results`

---

### `fema_get_disaster` <sub>tool</sub>

- Input: `disaster_number` (positive integer), obtained from `fema_search_disasters`
- Returns every designated county/municipality row for the declaration, with FIPS codes, incident period, and program flags OR'd across all areas
- Disaster numbers above 32767 (OpenFEMA's Int16 field limit) return `not_found` rather than a raw API type-mismatch error

---

### `fema_get_public_assistance` <sub>tool</sub>

- Requires `disaster_number` or `state` — at least one; optional `county` substring filter; paginated via `limit` (1–1000, default 100) / `offset`
- Returns applicant, damage category, project size/status, federal share obligated, and total obligated per project
- Typed errors: `invalid_state`, `missing_filter` (neither `disaster_number` nor `state` given), `no_results`

---

### `fema_get_housing_assistance` <sub>tool</sub>

- Input: `disaster_number` (required), optional `state` filter, `type` (`owners`/`renters`/`both`, default `both`); paginated via `limit` (1–1000, default 100) / `offset`
- Returns separate `owners` and `renters` arrays — registrations, approved amounts, and repair/rental/other-needs breakdowns by county and ZIP
- Typed errors: `invalid_state`, `no_results` (IA housing data can take weeks to appear after a declaration)

---

### `fema_search_nfip` <sub>tool</sub>

- `state` is required — the unfiltered NFIP Claims dataset is 2.7M rows; optional `county_code` (5-digit FIPS or a bare 3-digit code, auto-prefixed with the state FIPS), `zip_code`, `year_from`/`year_to`; inline preview capped at `limit` (1–10000, default 1000)
- When `CANVAS_PROVIDER_TYPE=duckdb` is set and results exceed the 100,000-character inline preview budget, the matching set spills to a DataCanvas table (up to 50,000 rows) and the response carries `canvas_id`/`canvas_table`; `truncated: true` marks a partial stage at that cap
- Without canvas enabled, results return inline only, bounded by `limit`
- Typed errors: `invalid_state`, `no_results`

---

### `fema_dataframe_describe` <sub>tool</sub>

All four canvas inputs (`fema_search_nfip`, `fema_dataframe_describe`, `fema_dataframe_query`, and `fema_dataframe_drop`) require a server-issued 10-character URL-safe ID matching `[A-Za-z0-9_-]{10}` when supplied. Omit it on the first NFIP search.

- Input: `canvas_id` from a `fema_search_nfip` response
- Lists table/view names, DuckDB column types, and nullability; row count reflects what was actually staged, not the inline preview
- Typed errors: `canvas_not_found`, `canvas_unavailable` (DataCanvas not enabled on this deployment)

---

### `fema_dataframe_query` <sub>tool</sub>

- Input: `canvas_id` plus a single SQL `query`; only SELECT statements are permitted — DDL, DML, COPY, and file-reading functions are blocked
- Results are capped at the canvas row limit; a capped response sets `truncated`/`shown`/`cap` enrichment fields with LIMIT/OFFSET paging guidance
- Typed errors: `canvas_not_found`, `canvas_unavailable`, `invalid_query`, `sql_execution_error` (use `TRY_CAST` or filter incompatible values)

---

### `fema_dataframe_drop` <sub>tool</sub>

- Opt-in: not registered (absent from `tools/list`) unless `FEMA_ENABLE_CANVAS_DROP=true`
- Input: `canvas_id` and the exact `table_name` from `fema_dataframe_describe`
- Removes one staged table or view only — never changes FEMA source data; `dropped: false` when the name doesn't exist
- Typed errors: `canvas_not_found`, `canvas_unavailable`

---

### `fema_query_dataset` <sub>tool</sub>

- Input: `dataset` (case-sensitive OpenFEMA v2 entity name), optional raw OData `filter`/`select`/`orderby`, `limit` (1–10000, default 100) / `offset`
- Escape hatch for datasets the convenience tools don't cover (e.g. `FimaNfipPolicies`, `IndividualAssistanceHousingRegistrantsLargeDisasters`); for NFIP Policies use `propertyState` (not `state`) and always include a county or ZIP filter to avoid timeout
- Typed errors: `unknown_dataset` (name not recognized), `invalid_filter` (OData syntax error)

---

### `fema://disaster/{disasterNumber}` <sub>resource</sub>

- Params: `disasterNumber` as a string
- Returns title, state, incident type, declaration type/date, incident period, `programs_declared` array, and `designated_area_count`
- Disaster numbers above 32767 return not-found, same as `fema_get_disaster`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

OpenFEMA-specific:

- Typed OpenFEMA REST client with `%24`-prefixed OData parameter encoding (an Akamai requirement) and structured error classification distinguishing JSON 400 responses from HTML Drupal error pages
- Automatic deduplication of `DisasterDeclarationsSummaries` — one row per designated area collapsed to declaration-level summaries with `designated_area_count`
- NFIP Claims guard: `state` filter is required to prevent unbounded 2.7M-row fetches
- DataCanvas spillover for NFIP analytics — large NFIP result sets materialize as DuckDB tables queryable via SQL without re-fetching
- No API keys required — OpenFEMA is a free, public API

Agent-friendly output:

- Disaster number is the explicit join key across all datasets — every tool that touches a disaster surfaces it prominently so agents can chain calls without re-searching
- Typed error contracts on every tool — `invalid_state`, `no_results`, `missing_filter`, `unknown_dataset`, `invalid_filter`, `canvas_unavailable` — with recovery hints telling agents the concrete next step
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
| `FEMA_BASE_URL` | Override the OpenFEMA API base URL. | `https://www.fema.gov/api/open/v2` |
| `FEMA_REQUEST_TIMEOUT_MS` | Total budget in milliseconds for one upstream exchange, including response body, retries, and backoff. NFIP county queries can be slow. | `30000` |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas for NFIP Claims analytics. Without it, `fema_search_nfip` inlines results up to the cap. | — |
| `FEMA_ENABLE_CANVAS_DROP` | Enable the destructive `fema_dataframe_drop` tool for removing staged tables and views. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | Session mode: `auto`, `stateful`, or `stateless`. Overrides this server's explicit stateless default. The framework schema default `auto` resolves to stateful. | `stateless` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/fema-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them. Production dependencies, including the DuckDB native binding, are installed directly in the runtime stage without lifecycle scripts.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — one file per tool. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/openfema` | OpenFEMA REST API client — OData param builder, response parser, error classifier, retry wrapper. |
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
