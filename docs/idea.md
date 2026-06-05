---
name: fema-mcp-server
description: "US disaster data via OpenFEMA — disaster declarations, public assistance, and National Flood Insurance Program records."
version: 0.0.0
status: idea
category: external-data
hosted: false
subdomain: ""
port: 0
tools: 0
resources: 0
prompts: 0
rating: unrated
stars: 0
open_issues: 0
auth: none
framework: mcp-ts-core
core_version: ""
npm: "@cyanheads/fema-mcp-server"
created: 2026-05-30
error_handling: unaudited
response_enrichment: unaudited
needs_migration: false
mirror: "T1 selective — bounded OpenFEMA datasets (disaster declarations) → SQLite; large sets (NFIP claims ~2.5M rows) stay live or selectively mirrored. MirrorService (core#164)."
pattern: multi-endpoint single-source
complexity: medium
api-deps: OpenFEMA API (FEMA open datasets)
api-cost: free (no key)
hostable: true
composes-with: reliefweb-mcp-server, earthquake-mcp-server, usgs-water-mcp-server, nws-weather-mcp-server
---

# fema-mcp-server

US disaster data via [OpenFEMA](https://www.fema.gov/about/openfema/api) — federal disaster declarations, public-assistance funding, individual-assistance housing data, and National Flood Insurance Program (NFIP) claims and policies. Keyless, dozens of datasets under one query interface.

The fleet's disaster coverage is `reliefweb` (international humanitarian) and `earthquake`/`usgs-water` (hazard monitoring) — but nothing on the **US federal disaster apparatus**: which disasters were declared, where federal money went, and the flood-insurance record. FEMA is the authoritative US source. Pairs naturally with ReliefWeb (US ↔ international) and the hazard servers (the event ↔ the federal response).

**Audience:** Journalists, researchers, emergency planners, insurance/risk analysts, residents checking disaster history, agents answering "what disasters were declared in Florida last year?" or "how many flood claims in this county?"

## User Goals

- Find federal disaster declarations by state, type, and date
- Get detail on a specific declaration and the programs activated
- See public-assistance funding (where federal disaster money went)
- Query National Flood Insurance claims/policies for an area
- Run a filtered query against any OpenFEMA dataset

## API Surface

Keyless REST at `fema.gov/api/open/`, dozens of datasets with a shared OData-style query grammar (`$filter`, `$select`, `$top`, `$skip`, `$orderby`, `$inlinecount`). Responses carry a `metadata` block + the entity array.

| Dataset | Purpose |
|:--------|:--------|
| `DisasterDeclarationsSummaries` | Every federal disaster declaration — type, state, county, incident type, dates, programs |
| `PublicAssistanceFundedProjectsDetails` | PA grants — where disaster recovery money went, by project |
| `FimaNfipClaims` | National Flood Insurance Program claims (location, amount, date) |
| `FimaNfipPolicies` | NFIP policies in force |
| `HousingAssistanceOwners` / `…Renters` | Individual-assistance housing data by disaster |

The `$filter` grammar is the whole interface — one generic query tool covers the long tail; convenience tools cover the headline questions.

## Tool Surface (sketch)

```
fema_search_disasters    — federal disaster declarations. Filters: state, declaration
                           type (major disaster / emergency / fire), incident type
                           (hurricane, flood, severe storm, fire, ...), date range,
                           county. Returns declaration number, title, state, incident
                           type, dates, and programs declared (IA/PA/HM). The headline
                           tool — "what was declared in Texas in 2025?"

fema_get_disaster        — detail for a disaster (by declaration number / disaster
                           number): designated areas, programs, incident period, and
                           the declaration timeline.

fema_get_public_assistance — public-assistance funded projects for a disaster or state:
                           applicant, project type, federal share, total obligated.
                           "Where did the recovery money go after Hurricane X?"

fema_search_nfip         — National Flood Insurance Program claims/policies for a state/
                           county/ZIP: claim counts and amounts, policies in force.
                           Spills to DataCanvas for aggregation over large result sets.

fema_get_housing_assistance — individual-assistance housing data for a disaster:
                           IA housing grants by disaster number and state, owner and
                           renter breakdowns, registered applicants, and amounts
                           approved. Covers HousingAssistanceOwners /
                           HousingAssistanceRenters datasets.

fema_query_dataset       — generic OData query against any OpenFEMA dataset: $filter,
                           $select, $orderby, pagination. The escape hatch for the
                           datasets the convenience tools don't cover.
```

## Design Notes

- Medium complexity — keyless, but the **OData-style query grammar** (`$filter` with `eq`/`ge`/`le`/`and`/`substringof`) and **deep pagination** (1,000 records/page via `$top`/`$skip`, some datasets are millions of rows) are the work. The service layer must translate friendly params into `$filter` and paginate safely.
- **Convenience tools over the headline datasets** (declarations, PA, NFIP) + **one generic `fema_query_dataset`** for the long tail — same split that works for tabular-API servers. Don't write a tool per dataset.
- NFIP and PA datasets are **huge** — never fetch unbounded; require a geographic or disaster filter, cap with counts, and spill to DataCanvas for aggregation. Use `$inlinecount` to report totals honestly.
- Disaster/declaration numbers are the join key across datasets (a declaration → its PA projects → its housing assistance) — surface them so the agent can chain.
- Coverage is **US federal** disasters/programs only (not state-level, not international — that's `reliefweb`). State it.
- Composes with `reliefweb` (US federal response ↔ international humanitarian view), `earthquake`/`usgs-water` (the hazard event ↔ the federal declaration and flood claims that followed), `nws-weather` (the storm ↔ the disaster).
- Moonshot: a "disaster history for my area" workflow — declarations, federal dollars, and flood-claim trends for a county assembled into one risk profile.
- README one-liner: "US disaster declarations, federal recovery funding, and flood-insurance records from OpenFEMA, no key."
