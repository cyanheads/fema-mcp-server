# FEMA MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `fema_search_disasters` | Search federal disaster declarations by state, incident type, declaration type, date range, and county. Returns deduplicated declaration-level summaries — disaster number (chain key for PA/IA tools), title, state, incident type, dates, programs declared (IA/PA/HM), and `designatedAreaCount`. The primary entry point — "what disasters were declared in Texas in 2025?" | `state` (2-letter), `incident_type`, `declaration_type` (enum: `DR`/`EM`/`FM`), `date_from`, `date_to`, `county`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |
| `fema_get_disaster` | Fetch all records for a specific disaster by disaster number (e.g., 4781). Returns every designated-area row for that declaration with programs activated, incident period, and county breakdowns. Chains to PA and housing assistance tools via the disaster number. | `disaster_number` | `readOnlyHint: true`, `openWorldHint: false` |
| `fema_get_public_assistance` | Public-assistance funded projects for a disaster or state — where federal recovery money went. Returns applicant, damage category, project size/status, federal share obligated, and total obligated. Requires `disaster_number` or `state`. | `disaster_number`, `state`, `county`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |
| `fema_get_housing_assistance` | Individual-assistance housing data for a disaster. Returns IA housing grants by county/ZIP — owner and renter breakdowns, valid registrations, total approved IHP amounts, and repair/rental amounts. Covers HousingAssistanceOwners and HousingAssistanceRenters datasets. | `disaster_number`, `state`, `type` (owners/renters/both), `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |
| `fema_search_nfip` | National Flood Insurance Program claims for a state, county, or ZIP. Returns claim counts, amounts paid on building and contents claims, flood zones, and loss years. Large result sets spill to a DataCanvas table for SQL-based aggregation. Requires at least `state`. | `state`, `county_code`, `zip_code`, `year_from`, `year_to`, `limit`, `canvas_id` | `readOnlyHint: true`, `openWorldHint: true` |
| `fema_dataframe_query` | Run a SELECT query against a DataCanvas table previously staged by `fema_search_nfip`. Enables aggregation, grouping, and time-series analysis over the full NFIP dataset without re-fetching. | `canvas_id`, `query` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `fema_dataframe_describe` | List columns and row count for a DataCanvas table staged by `fema_search_nfip`. Use before `fema_dataframe_query` to discover the schema. | `canvas_id` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `fema_query_dataset` | Generic OData query against any OpenFEMA v2 dataset — the escape hatch for datasets the convenience tools don't cover (FimaNfipPolicies, IndividualAssistanceHousingRegistrantsLargeDisasters, etc.). Accepts raw `$filter`, `$select`, `$orderby`, and pagination params. | `dataset`, `filter`, `select`, `orderby`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |

### Error Contracts

Domain failures for each tool (baseline codes — `InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError` — bubble freely and don't need declaring):

| Tool | `reason` | Code | When |
|:-----|:---------|:-----|:-----|
| `fema_search_disasters` | `invalid_state` | `InvalidParams` | `state` is not a valid 2-letter US state code |
| `fema_search_disasters` | `no_results` | `NotFound` | Query returned 0 declarations |
| `fema_get_disaster` | `not_found` | `NotFound` | `disaster_number` has valid format but no matching declaration exists |
| `fema_get_public_assistance` | `missing_filter` | `InvalidParams` | Neither `disaster_number` nor `state` was provided |
| `fema_get_public_assistance` | `no_results` | `NotFound` | Disaster has no PA project records (e.g., PA program not declared) |
| `fema_get_housing_assistance` | `no_results` | `NotFound` | Disaster has no IA housing records (e.g., IA program not declared) |
| `fema_search_nfip` | `state_required` | `InvalidParams` | `state` was not provided (unfiltered NFIP Claims is 2.7M rows — prohibited) |
| `fema_query_dataset` | `unknown_dataset` | `NotFound` | Dataset name not recognized — API returned HTML 404 instead of JSON |
| `fema_query_dataset` | `invalid_filter` | `InvalidParams` | OData `$filter` parse error — API returned 400 with `OF_OQP_*` error code |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `fema://disaster/{disasterNumber}` | Summary for a specific disaster declaration — title, state, incident type, programs, incident period. Read-once context injection for agents already holding a disaster number. | No |

### Prompts

None — data-oriented server, no recurring workflow templates needed.

---

## Overview

OpenFEMA is FEMA's open-data API: every federal disaster declaration since 1953, public-assistance grant records, National Flood Insurance Program (NFIP) claims and policies, and individual-assistance housing data. Keyless, dozens of datasets, one shared OData-style query interface.

This server fills the gap in the fleet's disaster coverage: `reliefweb` covers international humanitarian events; `earthquake`/`usgs-water` cover hazard monitoring — but nothing tracks the **US federal disaster apparatus**: which disasters were declared, where federal money went, and the flood-insurance record. FEMA is the authoritative US source.

**Audience:** Journalists, researchers, emergency planners, insurance/risk analysts, residents checking local disaster history.

---

## Requirements

- No API key. OpenFEMA is keyless and public.
- Read-only access. No write operations exist in the API.
- Disaster number is the join key across datasets: declaration → PA projects → housing assistance.
- NFIP Claims (~2.7M rows) must never be fetched unbounded. Requires at minimum a `state` filter, caps at a per-request limit, and spills analytical result sets to DataCanvas.
- NFIP Policies is very large and slow. Exposed only via `fema_query_dataset` (generic escape hatch). Requires county or ZIP filter at minimum.
- `$inlinecount=allpages` is required to get actual total counts; without it the root-level `count` field returns 0. The service layer reads `response.count`, not `response.metadata.count`.
- The `$` OData param prefix must be URL-encoded as `%24` — Akamai's Drupal layer at fema.gov rejects dollar-sign params in GET query strings unless percent-encoded.
- 400 errors return JSON: `{"error":[{"name":"...", "code":"OF_OQP_002", "message":"..."}]}`.
- 404 for unknown dataset names returns an HTML Drupal error page (not JSON — detect by Content-Type).
- `DisasterDeclarationsSummaries` returns one row per designated area per disaster, not one row per disaster. Grouping or `disasterNumber` filtering is needed to work at the declaration level.
- NFIP Policies uses `propertyState` not `state` as the state field.
- NFIP Claims uses `countyCode` (camelCase) in the OData filter; the tool's snake_case input param `county_code` must be mapped to `countyCode` in the filter expression builder.
- `declaration_type` is a 3-value enum (`DR`, `EM`, `FM`) — constrain with `z.enum(['DR', 'EM', 'FM'])` not a free string.
- `year_from` / `year_to` for NFIP are integer years (e.g. `2020`) that map to OData `yearOfLoss ge 2020` — constrain with `z.number().int()`.
- Housing Assistance datasets include `city` alongside `county` and `zipCode` — include in output schema for geocoding/display use.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `OpenFemaService` | OpenFEMA REST API (`https://www.fema.gov/api/open/v2/`) | All tools |
| `CanvasService` (framework) | DuckDB via `core.canvas` | `fema_search_nfip`, `fema_dataframe_query`, `fema_dataframe_describe` |

`OpenFemaService` encapsulates the `%24`-encoded OData parameter building, pagination, error-shape detection (JSON 400 vs HTML 404), and retry logic.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CANVAS_PROVIDER_TYPE` | No | Set to `duckdb` to enable DataCanvas for NFIP analytics. Without it, `fema_search_nfip` inlines results up to the cap and omits `canvas_id`. |
| `FEMA_BASE_URL` | No | Override API base (default: `https://www.fema.gov/api/open/v2`). Useful for test environments. |
| `FEMA_REQUEST_TIMEOUT_MS` | No | HTTP request timeout in milliseconds (default: 30000). NFIP county queries can be slow. |

---

## Implementation Order

1. **Config and service setup** — `src/config/server-config.ts`, `OpenFemaService` with OData param builder, response parser, error classifier, and retry wrapper.
2. **`fema_search_disasters`** — primary tool over `DisasterDeclarationsSummaries`. Groups or presents per-area rows.
3. **`fema_get_disaster`** — single disaster by number, all designated areas.
4. **`fema_get_public_assistance`** — `PublicAssistanceFundedProjectsDetails` by disaster number or state.
5. **`fema_get_housing_assistance`** — `HousingAssistanceOwners` + `HousingAssistanceRenters` by disaster number, merged under `type` param.
6. **`fema_search_nfip`** + **`fema_dataframe_describe`** + **`fema_dataframe_query`** — NFIP Claims with spillover, canvas wiring.
7. **`fema_query_dataset`** — generic escape hatch.
8. **`fema://disaster/{disasterNumber}` resource** — wraps `fema_get_disaster` output as URI resource.

Each step is independently testable via the mock service pattern.

---

## Domain Mapping

| Noun | Dataset | Key Fields | Record Scale |
|:-----|:--------|:-----------|:-------------|
| Disaster Declaration | `DisasterDeclarationsSummaries` | `disasterNumber`, `declarationTitle`, `state`, `incidentType`, `declarationType`, `declarationDate`, `iaProgramDeclared`, `paProgramDeclared`, `hmProgramDeclared`, `incidentBeginDate`, `incidentEndDate`, `designatedArea`, `fipsStateCode`, `fipsCountyCode` | ~70K rows (1 per designated area) |
| PA Project | `PublicAssistanceFundedProjectsDetails` | `disasterNumber`, `pwNumber`, `applicantId`, `applicationTitle`, `damageCategoryCode`, `damageCategoryDescrip`, `projectAmount`, `federalShareObligated`, `totalObligated`, `county`, `countyCode`, `stateAbbreviation`, `stateNumberCode`, `projectStatus`, `projectSize`, `projectProcessStep`, `firstObligationDate`, `lastObligationDate`, `mitigationAmount` | ~1K/disaster |
| Housing Assistance (Owner) | `HousingAssistanceOwners` | `disasterNumber`, `state`, `county`, `city`, `zipCode`, `validRegistrations`, `totalInspected`, `totalDamage`, `averageFemaInspectedDamage`, `noFemaInspectedDamage`, `approvedForFemaAssistance`, `totalApprovedIhpAmount`, `repairReplaceAmount`, `rentalAmount`, `otherNeedsAmount`, `totalMaxGrants` | ~1K/disaster |
| Housing Assistance (Renter) | `HousingAssistanceRenters` | Same as owners + `totalWithMajorDamage`, `totalWithModerateDamage`, `totalWithSubstantialDamage`, `totalInspectedWithNoDamage` | ~1K/disaster |
| NFIP Claim | `FimaNfipClaims` | `state`, `countyCode`, `reportedZipCode`, `dateOfLoss`, `yearOfLoss`, `amountPaidOnBuildingClaim`, `amountPaidOnContentsClaim`, `buildingDamageAmount`, `contentsDamageAmount`, `ratedFloodZone`, `causeOfDamage`, `occupancyType` | ~2.7M rows total |
| NFIP Policy | `FimaNfipPolicies` | `propertyState`, `countyCode`, `reportedZipCode`, `ratedFloodZone`, `policyEffectiveDate`, `policyTerminationDate`, `totalBuildingInsuranceCoverage`, `totalContentsInsuranceCoverage`, `totalInsurancePremiumOfThePolicy`, `policyCount` | Very large (~millions) |

---

## Workflow Analysis

**`fema_search_nfip` — NFIP claims with analytical spillover**

| # | Call | Purpose | Condition |
|:--|:-----|:--------|:----------|
| 1 | `GET FimaNfipClaims?$filter=...&$top=N&$inlinecount=allpages` | Fetch filtered page of claims | always |
| 2 | `spillover(rows, canvas)` | Stage full result set in DuckDB canvas table | when `canvas` enabled and count > inline cap |
| 3 | Return inline preview + `canvas_id` | Agent sees compact summary; canvas enables SQL | when spilled |

The service layer builds the `$filter` expression from `state`, `county_code`, `zip_code`, and year range. `state` is required — an unfiltered NFIP Claims fetch is 2.7M rows. The response always includes total count from `$inlinecount`. When canvas is disabled, the tool returns the inline page only and notes how to get more via pagination.

---

## Design Decisions

**One tool per dataset group, not one per dataset.** `HousingAssistanceOwners` and `HousingAssistanceRenters` are structurally similar and always queried together for a disaster. A single `fema_get_housing_assistance` with a `type` param (owners/renters/both) is cleaner than two separate tools. Same logic would apply to merging IA sub-datasets.

**NFIP Policies excluded from convenience tools.** `FimaNfipPolicies` times out on state-level queries and uses different field names (`propertyState` instead of `state`). Its analytical shape differs from claims — active policy counts, premium amounts, flood zones — but its size and latency make a convenience wrapper dangerous without tight geographic bounds. `fema_query_dataset` is the access path; agents that need policy data provide the filter.

**`DisasterDeclarationsSummaries` returns one row per designated area.** A single declaration for a state yields dozens of rows — one per county or municipality designated. `fema_search_disasters` and `fema_get_disaster` surface this transparently: search returns deduplicated declaration-level summaries with `designatedAreaCount`; get_disaster returns all area rows. The design documents this behavior explicitly so agents aren't surprised.

**DataCanvas for NFIP Claims, not for other datasets.** PA Projects (~1K/disaster) and Housing Assistance (~1K/disaster) fit inline. NFIP Claims is 2.7M rows with a genuinely analytical shape — agents would aggregate by flood zone, year, county, amount buckets. Canvas earns its keep here on both shape (SQL-worthy: GROUP BY, SUM, time-series) and size. PA and housing stay inline.

**`$inlinecount=allpages` always on filtered queries.** Without it, the root-level `count` field is 0 and the agent can't assess result completeness. Always send it on queries that have filters; the overhead is minimal.

**`fema_query_dataset` as the long-tail escape hatch.** OpenFEMA has dozens of datasets beyond the headline five. A generic query tool with the full OData parameter set surfaces the rest without a per-dataset tool explosion. The tool validates the dataset name returns JSON (Content-Type check) before forwarding the response body.

---

## Known Limitations

- **Akamai blocks un-encoded `$` params.** The service layer must percent-encode `$` as `%24` in all query parameters. This is already the standard behavior of `new URLSearchParams()` in Node/Bun.
- **NFIP Policies is very slow** on anything larger than a ZIP-level query. No convenience tool; documented for `fema_query_dataset` users.
- **`count` is `0` without `$inlinecount=allpages`.** The `count` field is at the response root (not nested under `metadata`) and returns 0 by default. Always request `$inlinecount=allpages` on filtered queries. The service layer must read `response.count`, not `response.metadata.count`.
- **HTML 404 on unknown datasets.** The API returns a Drupal HTML error page (not JSON) for unknown dataset names. The service layer detects this via Content-Type and throws a `NotFound` with a clear message.
- **Temporal lag.** NFIP and PA data has reporting delays — recent events may have incomplete records for weeks to months after the disaster.

---

## API Reference

**Base URL:** `https://www.fema.gov/api/open/v2/{DatasetName}`

**OData query parameters** (must be `%24`-encoded in URL):

| Param | Example | Notes |
|:------|:--------|:------|
| `$filter` | `state eq 'TX' and declarationDate ge '2024-01-01T00:00:00.000Z'` | OData 3 filter syntax. String values in single quotes. Supports `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `and`, `or`, `not`, `substringof`. |
| `$select` | `disasterNumber,declarationTitle,state` | Comma-separated field names. Dramatically reduces payload for large result sets. |
| `$top` | `100` | Max records per page. API default is 1000; no documented hard cap beyond that. |
| `$skip` | `1000` | Offset for pagination. Use `$top + $skip` to page. |
| `$orderby` | `declarationDate desc` | Sort expression. Field + `asc`/`desc`. |
| `$inlinecount` | `allpages` | Only valid value. Returns total matching count in the root-level `count` field. |

**Response envelope:**

Metadata fields are **at the response root** (not nested under a `"metadata"` key). `count` is `0` without `$inlinecount=allpages`; send it on every filtered query to get a real total.

```json
{
  "skip": 0,
  "top": 100,
  "filter": "state eq 'TX'",
  "select": null,
  "orderby": "",
  "count": 195,
  "rundate": "2026-06-04T23:17:36.211Z",
  "entityname": "DisasterDeclarationsSummaries",
  "format": "json",
  "metadata": true,
  "version": "v2",
  "url": "...",
  "DisasterDeclarationsSummaries": [ ... ]
}
```

**Error response (400):**

```json
{
  "error": [{
    "name": "OData Query Parser Error",
    "code": "OF_OQP_002",
    "type": "$filter criteria error",
    "message": "Field \"INVALID_FIELD\" not found in the model path ..."
  }]
}
```

**404:** Returns HTML Drupal page. Detect via `Content-Type: text/html`.
