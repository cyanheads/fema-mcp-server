# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
