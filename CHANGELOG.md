# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-07-09

fema_search_nfip raises canvas page size to 5000 for large queries; fema_dataframe_query discloses capped SQL results with LIMIT/OFFSET continuation guidance

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-07-09

fema_search_disasters reports total_declarations and repoints pagination to declaration-level counts; fema_query_dataset and fema_get_housing_assistance fix field/sparse-record rendering gaps; mcp-ts-core ^0.10.14 adoption with supply-chain hardening

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-07-04

fema_dataframe_describe/query throw typed canvas_unavailable instead of InternalError when DataCanvas is disabled; OpenFemaService throw sites now surface declared recovery hints and drop the raw upstream name field

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-07-04 · 🛡️ Security

Declaration-type render prefixes (FM/EM/DR), consistent invalid_state validation across all state-scoped tools, fema_search_nfip no_results contract; mcp-ts-core ^0.10.10 clears 7 bun audit advisories

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-06-20

Adopt mcp-ts-core ^0.10.9 — Canvas describe() filter-qualification fix, invalid_sql gate classification, two new devcheck guards (dependency specifiers, plugin manifests), @duckdb/node-api + dev-dep refresh

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-06-11

Adopt mcp-ts-core ^0.10.6 — server identity name/title pair, totalCount enrichment on the four capped-list tools, post-pack bundle cleaner

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-06-10

NFIP canvas now stages the full matching result set; 3-digit county codes normalize to 5-digit FIPS; unknown-dataset errors no longer leak transport detail

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-06-08 · 🛡️ Security

ValidationError for domain-validation failures; mcp-ts-core ^0.10.1 (DataCanvas SQL gate hardened, .mcpbignore re-anchored)

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-08

Correct ia_declared to use ihProgramDeclared (IHP flag) with OR rollup across area rows; fix limit/offset pagination to operate on deduplicated declarations

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-06

Three API error-handling fixes: Int16 range guard for fema_get_disaster, recovery hint in structuredContent for no-results, sanitized filter error messages

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-06

Public hosted endpoint at https://fema.caseyjhand.com/mcp

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-05

OpenFEMA required usage disclaimer and dataset citation format added to README

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-05 · 🛡️ Security

Initial public release — 8 tools, 1 resource over the OpenFEMA API (disaster declarations, public assistance, housing aid, NFIP claims) with DataCanvas SQL and OData injection hardening
