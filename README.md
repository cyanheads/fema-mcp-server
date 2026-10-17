<div align="center">
  <h1>@cyanheads/fema-mcp-server</h1>
  <p><b>Query FEMA disaster declarations, public assistance grants, housing aid, and NFIP flood insurance claims via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 1 Opt-in Tool • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/fema-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/fema-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/fema-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

`fema_dataframe_drop` is opt-in: it appears in `tools/list` only when `FEMA_ENABLE_CANVAS_DROP=true`. The other eight tools are always listed.

### Resources

| Resource | Description |
|:---|:---|
| `fema://disaster/{disasterNumber}` | Summary for a specific FEMA disaster declaration — title, state, incident type, programs, incident period |

All resource data is also reachable via tools. Use `fema_get_disaster` for the same data with full designated-area detail.

## Capability reference

### `fema_search_disasters` <sub>tool</sub>

- Filters: `state`, `incident_type`, `declaration_type` (`DR`/`EM`/`FM`), inclusive `date_from`/`date_to` (`YYYY-MM-DD`), and `county`. `incident_type` and `county` are case-insensitive substring matches. Page with `limit` (1–1000, default 50) and `offset`; a page stops at 100,000 characters and `next_offset` says where to resume.
- Returns one summary per disaster number with `designated_area_count`, program flags, and declaration totals. With `county`, `total_area_rows` and `matched_areas` (FIPS codes and per-area flags) show the matching areas. Errors: `invalid_state`, `invalid_range` (`date_from` after `date_to`), `no_results`, `request_too_long`.
- Searches the most recent 10,000 designated-area rows. When capped, results are marked `truncated`, totals are lower bounds, and `notice` names the next `date_to`.

---

### `fema_get_disaster` <sub>tool</sub>

- Requires `disaster_number` from `fema_search_disasters`.
- Returns all designated-area records, FIPS codes, incident period, and program flags combined across areas; a missing disaster returns `not_found`.

---

### `fema_get_public_assistance` <sub>tool</sub>

- Requires `disaster_number` or `state`; optional `county` (case-insensitive substring), `limit` (1–10000, default 100), and `offset`. A page stops at 100,000 characters; `next_offset` says where to resume.
- Returns applicants, damage categories, project size/status, and federal and total obligations. Errors: `invalid_state`, `missing_filter`, `not_found`, `no_results`, `request_too_long`.

---

### `fema_get_housing_assistance` <sub>tool</sub>

- Requires `disaster_number`; optional `state`, `county` (case-insensitive substring), `zip_code` (5 digits), `type` (`owners`/`renters`/`both`, default `both`), `limit` (1–10000, default 100), and `offset`. A page stops at 100,000 characters; one `next_offset` continues both owners and renters.
- Returns separate `owners` and `renters` arrays with county/ZIP registrations, approved amounts, and inspection counts, plus `owners_count`/`renters_count`. Owners also carry inspected damage in USD; renters carry damage-degree counts only. Errors: `invalid_state`, `not_found`, `no_results`, `request_too_long`.

---

### `fema_search_nfip` <sub>tool</sub>

- Requires `state`; optional `county_code` (5-digit FIPS like `48201`, or a 3-digit code like `201` that gets the state prefix), `zip_code`, `year_from`/`year_to`, `limit` (1–10000, default 1000), and `offset`. Results come newest loss first.
- Inline claims stop at 100,000 characters; `next_offset` and `notice` say how to continue. Errors: `invalid_state`, `invalid_county_code` (anything but 1–5 digits, or a short code for FM, MH, or PW), `invalid_range` (`year_from` after `year_to`), `no_results`.
- With `CANVAS_PROVIDER_TYPE=duckdb`, a first-page match over the inline limit stages up to 50,000 rows. `canvas_id`, `canvas_table`, and `staged_count` identify the stage, `truncated: true` marks its cap, and `total_count` is the full match. Inspect it with `fema_dataframe_describe`, then query it with `fema_dataframe_query`.

---

### `fema_dataframe_describe` <sub>tool</sub>

- Requires `canvas_id` from `fema_search_nfip`.
- Lists table/view names, column types, nullability, and staged row counts. Typed errors: `canvas_not_found`, `canvas_unavailable`.

---

### `fema_dataframe_query` <sub>tool</sub>

- Requires `canvas_id` and a single SQL `query`; only SELECT is allowed.
- Rows are capped at the canvas row limit and 100,000 characters; `truncated`/`shown` and OFFSET guidance appear when the result is cut. Errors: `canvas_unavailable`, `canvas_not_found`, `missing_table`, `invalid_sql`, `non_select_statement`, `multi_statement`, `denied_function`, `plan_operator_not_allowed`, `sql_read_only`, `sql_execution_error` (use `TRY_CAST` or filter incompatible values).

---

### `fema_dataframe_drop` <sub>tool</sub>

- Requires `canvas_id` and the exact `table_name` from `fema_dataframe_describe`.
- Removes one staged table or view; `dropped: false` means the name did not exist. Errors: `canvas_not_found`, `canvas_unavailable`.
- Opt-in through `FEMA_ENABLE_CANVAS_DROP=true`.

---

### `fema_query_dataset` <sub>tool</sub>

- Requires a case-sensitive OpenFEMA `dataset`; optional OData `filter`/`select`/`orderby`, `limit` (1–10000, default 100), and `offset`. A page stops at 100,000 characters; `next_offset` says where to resume.
- Returns records and `total_count`. Errors: `unknown_dataset`, `dataset_not_served`, `catalog_unavailable` (retryable), `invalid_filter`, `invalid_select`, `invalid_orderby`, `invalid_odata_syntax`, `request_too_long` (URL past about 8,900 characters), `filter_too_complex` (nested more than 100 levels).
- For a list of values, use `field in ('a','b')` instead of chained `or` comparisons (about 90 allowed). For `NfipPolicies`, use `propertyState` and `reportedZipCode`, and always include a ZIP filter to avoid timeout.

---

### `fema://disaster/{disasterNumber}` <sub>resource</sub>

- Requires `disasterNumber` as a string of digits.
- Returns title, state, incident type, declaration type/date, incident period, `programs_declared`, and `designated_area_count`; `not_found` carries recovery guidance pointing to `fema_search_disasters`.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

OpenFEMA-specific:

- Case-insensitive county and incident type filters, using a bundled snapshot of OpenFEMA names (refresh with `bun run vocabulary:build`)
- `DisasterDeclarationsSummaries` rows collapse to one summary per declaration, with `designated_area_count`
- `fema_search_nfip` requires `state`, which prevents unbounded 2.7M-row fetches
- Large NFIP result sets spill into DuckDB tables you can query with SQL via DataCanvas
- No API keys required — OpenFEMA is a free, public API

Agent-friendly output:

- Disaster number is the join key across tools, so calls chain without re-searching
- Typed errors on every tool (`invalid_state`, `invalid_county_code`, `invalid_range`, `no_results`, `not_found`, `missing_filter`, `unknown_dataset`, `dataset_not_served`, `invalid_filter`, `invalid_select`, `invalid_orderby`, `invalid_odata_syntax`, `request_too_long`, `filter_too_complex`, `canvas_unavailable`), each with a recovery hint
- `designated_area_count` on search results shows whether `fema_get_disaster` is worth a follow-up

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
| `FEMA_BASE_URL` | OpenFEMA API root. | `https://www.fema.gov/api/open` |
| `FEMA_REQUEST_TIMEOUT_MS` | Total time budget in milliseconds for one upstream request, including retries. | `30000` |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas SQL analytics for NFIP claims. | — |
| `FEMA_ENABLE_CANVAS_DROP` | Enable the `fema_dataframe_drop` tool. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | Session mode: `auto`, `stateful`, or `stateless`. | `stateless` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed-call arguments and results, redacted by key name. Secrets in free-form values are retained. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | Byte cap per logged payload. | `16384` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base URL for traces and metrics. | — |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Traces endpoint, used as-is. | — |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Metrics endpoint, used as-is. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Log export endpoint; logs export only when this is set. | — |
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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/fema-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — one file per tool. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/openfema` | OpenFEMA REST API client, plus the case-insensitive name matcher and its bundled name vocabulary. |
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
