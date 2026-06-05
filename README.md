<div align="center">
  <h1>@cyanheads/fema-mcp-server</h1>
  <p><b>Query FEMA disaster declarations, public assistance grants, housing aid, and NFIP flood insurance claims via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/fema-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/fema-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/fema-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/fema-mcp-server/releases/latest/download/fema-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=fema-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmVtYS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22fema-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffema-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Eight tools covering the OpenFEMA data surface — convenience tools for the headline datasets, SQL analytics over large NFIP result sets via DuckDB canvas, and a generic escape hatch for datasets the convenience tools don't cover:

| Tool | Description |
|:---|:---|
| `fema_search_disasters` | Search federal disaster declarations by state, incident type, declaration type, date range, and county |
| `fema_get_disaster` | Fetch all designated-area records for a specific disaster by disaster number |
| `fema_get_public_assistance` | Public assistance funded projects for a disaster or state — where federal recovery money went |
| `fema_get_housing_assistance` | Individual assistance housing data for a disaster — owner and renter breakdowns by county/ZIP |
| `fema_search_nfip` | NFIP flood insurance claims for a state, county, or ZIP, with optional DataCanvas spillover for SQL analytics |
| `fema_dataframe_describe` | List columns and row counts for DataCanvas tables staged by `fema_search_nfip` |
| `fema_dataframe_query` | Run a SELECT query against a DataCanvas table staged by `fema_search_nfip` |
| `fema_query_dataset` | Generic OData query against any OpenFEMA v2 dataset — escape hatch for datasets the convenience tools don't cover |

### `fema_search_disasters`

The primary entry point — "what disasters were declared in Texas in 2025?"

- Filter by state (2-letter code), incident type (Hurricane, Flood, Wildfire, etc.), declaration type (`DR`/`EM`/`FM`), date range, and county
- Returns deduplicated declaration-level summaries — one row per declaration, not per designated area
- Includes disaster number (the join key for PA and housing tools), title, state, incident type, declaration/incident dates, programs declared (IA/PA/HM), and `designatedAreaCount`
- Paginated via `limit` / `offset`

---

### `fema_get_disaster`

Fetch all designated-area records for a specific FEMA disaster number.

- Returns every county/municipality row for the declaration with programs activated, incident period, and FIPS codes
- Use after `fema_search_disasters` to drill into a specific event; the disaster number chains to PA and housing tools
- `DisasterDeclarationsSummaries` returns one row per designated area — a single declaration can span dozens of counties

---

### `fema_get_public_assistance`

Retrieve PA funded project details — where federal recovery money went after a disaster.

- Filter by `disaster_number`, `state`, or `county`; at least one of `disaster_number` or `state` is required
- Returns applicant, damage category, project size/status, federal share obligated, and total obligated
- Useful for journalists, researchers, and oversight analysts tracking federal grant flows

---

### `fema_get_housing_assistance`

Individual assistance housing data for a disaster, broken down by county and ZIP.

- Returns owner and renter breakdowns via `type` param (`owners`/`renters`/`both`)
- Fields include valid registrations, total inspected, total damage, approved IHP amounts, repair/rental/other-needs amounts, and max grants
- Covers `HousingAssistanceOwners` and `HousingAssistanceRenters` datasets in a single call

---

### `fema_search_nfip`

NFIP flood insurance claims with optional DuckDB-backed SQL analytics for large result sets.

- Requires at minimum a `state` filter — unfiltered NFIP Claims is 2.7M rows
- Additional filters: `county_code`, `zip_code`, `year_from`, `year_to`; pagination via `limit`
- When `CANVAS_PROVIDER_TYPE=duckdb` is set and results exceed the inline cap, the full result set spills to a DataCanvas table and returns a `canvas_id` handle
- Use `fema_dataframe_describe` to inspect the schema, then `fema_dataframe_query` for aggregation, grouping, and time-series analysis without re-fetching

---

### `fema_dataframe_describe` / `fema_dataframe_query`

In-conversation SQL analytics over NFIP Claims data staged by `fema_search_nfip` on a DuckDB-backed DataCanvas.

- `fema_dataframe_describe`: lists columns, types, and row count for a canvas table — use before writing a query
- `fema_dataframe_query`: runs a single SELECT statement against the staged table; standard DuckDB SQL (GROUP BY, SUM, window functions, time-series)
- Workflow: `fema_search_nfip` (with canvas enabled) → `fema_dataframe_describe` → `fema_dataframe_query`
- Read-only — writes, DDL, and DROP are rejected by the framework SQL gate

---

### `fema_query_dataset`

Generic OData query against any OpenFEMA v2 dataset — the escape hatch for datasets the convenience tools don't cover.

- Accepts raw `$filter`, `$select`, `$orderby`, `limit`, and `offset` params
- Dataset name must match an actual OpenFEMA endpoint (e.g. `FimaNfipPolicies`, `IndividualAssistanceHousingRegistrantsLargeDisasters`)
- Validates that the API returns JSON (Content-Type check) and surfaces structured error codes on 400 responses

## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `fema://disaster/{disasterNumber}` | Summary for a specific FEMA disaster declaration — title, state, incident type, programs, incident period |

All resource data is also reachable via tools. Use `fema_get_disaster` for the same data with pagination and full designated-area detail.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

FEMA/OpenFEMA-specific:

- Typed OpenFEMA REST client with OData parameter building (`%24`-encoded to satisfy Akamai's Drupal layer), response parsing, and structured error classification (JSON 400 vs HTML 404)
- Automatic deduplication of `DisasterDeclarationsSummaries` — one row per designated area collapsed to declaration-level summaries with `designatedAreaCount`
- NFIP Claims guard: `state` filter is required to prevent unbounded 2.7M-row fetches
- DataCanvas spillover for NFIP analytics — large NFIP result sets materialize as DuckDB tables queryable via SQL without re-fetching
- No API keys required — OpenFEMA is a free, public API

Agent-friendly output:

- Disaster number is the explicit join key across all datasets — every tool that touches a disaster surfaces it prominently so agents can chain calls without re-searching
- Typed error contracts on every tool — `invalid_state`, `no_results`, `missing_filter`, `state_required`, `unknown_dataset`, `invalid_filter` — with recovery hints telling agents the concrete next step
- `designatedAreaCount` on search results so agents know whether to drill in with `fema_get_disaster` without having to fetch the full record first

## Getting started

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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `FEMA_REQUEST_TIMEOUT_MS` | Per-request HTTP timeout in milliseconds. NFIP county queries can be slow. | `30000` |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas for NFIP Claims analytics. Without it, `fema_search_nfip` inlines results up to the cap. | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/fema-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them. The `@duckdb/node-api` native binary is copied from the build stage, so the production image doesn't need build tools.

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
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

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
