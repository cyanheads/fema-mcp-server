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
| `fema_query_dataset` | Generic OData query against any dataset in the OpenFEMA dataset catalog, at the API version the catalog lists for it — the escape hatch for datasets the convenience tools don't cover (NfipPolicies, IndividualAssistanceHousingRegistrantsLargeDisasters, etc.). Accepts raw `$filter`, `$select`, `$orderby`, and pagination params. | `dataset`, `filter`, `select`, `orderby`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |

### Error Contracts

Domain failures each definition declares in `errors[]` (baseline codes — `InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError` — also bubble undeclared). Input-schema rejections — a missing required field, an out-of-range `limit`, a `date_from` that is not a `YYYY-MM-DD` calendar date — never reach a handler: they arrive as the framework's `invalid_arguments` reason with code `InvalidParams` and are not listed here.

Paging past the end is never an error. On `fema_search_disasters`, `fema_get_public_assistance`, `fema_get_housing_assistance`, and `fema_query_dataset`, an `offset` at or past a non-zero total returns the empty page with its totals and one `notice` naming the total and the last valid offset. `fema_query_dataset` declares no `no_results`: a match with a total of 0 is also a success, with a `notice` pointing at field names and filter syntax.

| Definition | `reason` | Code | When |
|:-----|:---------|:-----|:-----|
| `fema_search_disasters` | `invalid_state` | `ValidationError` | `state` is not a valid 2-letter US state/territory code |
| `fema_search_disasters` | `no_results` | `NotFound` | No declaration matches the filters. An `offset` past the last match is not this: it returns an empty page with the totals and a `notice` naming the last valid offset |
| `fema_get_disaster` | `not_found` | `NotFound` | No declaration has the number; a number above 32767 (OpenFEMA's Int16 limit) fails before any request |
| `fema_get_public_assistance` | `invalid_state` | `ValidationError` | `state` is not a valid 2-letter US state/territory code |
| `fema_get_public_assistance` | `missing_filter` | `ValidationError` | Neither `disaster_number` nor `state` was provided |
| `fema_get_public_assistance` | `not_found` | `NotFound` | `disaster_number` is above 32767 — fails before any request, with `fema_get_disaster`'s recovery |
| `fema_get_public_assistance` | `no_results` | `NotFound` | No PA project matches the filters (e.g., PA program not declared). An `offset` past the last match returns an empty page with a paging `notice` instead |
| `fema_get_housing_assistance` | `invalid_state` | `ValidationError` | `state` is not a valid 2-letter US state/territory code |
| `fema_get_housing_assistance` | `not_found` | `NotFound` | `disaster_number` is above 32767 — fails before either dataset is fetched, with `fema_get_disaster`'s recovery |
| `fema_get_housing_assistance` | `no_results` | `NotFound` | Every queried dataset reports a total of 0 (e.g., IA not declared, or data not yet published). A dataset whose total is non-zero but whose page is empty is past its end: success with a paging `notice` |
| `fema_search_nfip` | `invalid_state` | `ValidationError` | `state` is not a valid 2-letter US state/territory code |
| `fema_search_nfip` | `no_results` | `NotFound` | No NFIP claim matches the filters |
| `fema_dataframe_query` | `canvas_unavailable` | `ServiceUnavailable` | DataCanvas is disabled on this deployment (`CANVAS_PROVIDER_TYPE` is not `duckdb`) |
| `fema_dataframe_query` | `canvas_not_found` | `NotFound` | `canvas_id` names no active canvas session |
| `fema_dataframe_query` | `invalid_query` | `ValidationError` | Not a valid SELECT, references a missing table or column, or uses a blocked operation |
| `fema_dataframe_query` | `sql_execution_error` | `ValidationError` | The SELECT fails while converting or calculating values in the staged data |
| `fema_dataframe_describe` | `canvas_unavailable` | `ServiceUnavailable` | DataCanvas is disabled on this deployment |
| `fema_dataframe_describe` | `canvas_not_found` | `NotFound` | `canvas_id` names no active canvas session |
| `fema_dataframe_drop` | `canvas_unavailable` | `ServiceUnavailable` | DataCanvas is disabled on this deployment |
| `fema_dataframe_drop` | `canvas_not_found` | `NotFound` | `canvas_id` names no active canvas session |
| `fema_query_dataset` | `unknown_dataset` | `NotFound` | The dataset name is not in the OpenFEMA dataset catalog (no data request is made), or OpenFEMA has no endpoint for it |
| `fema_query_dataset` | `catalog_unavailable` | `ServiceUnavailable` | The dataset catalog could not be read and no earlier copy is cached — retryable |
| `fema_query_dataset` | `invalid_filter` | `ValidationError` | OpenFEMA 400 with `type: "$filter criteria error"` (unknown field, wrong value type, out-of-range integer, a quoted value that is not a date or GUID), or an untyped parser error when `filter` was the only expression sent |
| `fema_query_dataset` | `invalid_select` | `ValidationError` | OpenFEMA 400 with `type: "$select criteria error"`, or an untyped parser error when `select` was the only expression sent |
| `fema_query_dataset` | `invalid_orderby` | `ValidationError` | OpenFEMA 400 with `type: "$orderby criteria error"`, or an untyped parser error when `orderby` was the only expression sent |
| `fema_query_dataset` | `invalid_odata_syntax` | `ValidationError` | Untyped parser error (`{"name":"Error","message":"Fail at 0"}`) with several expressions sent — OpenFEMA does not say which failed |
| `fema://disaster/{disasterNumber}` | `not_found` | `NotFound` | The number is malformed (anything but digits), outside 1–32767 — neither reaches OpenFEMA — or matches no declaration; resource errors carry the reason and recovery on the JSON-RPC `error.data` |

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
- `$inlinecount=allpages` is required to get actual total counts; without it `metadata.count` is 0. The service layer reads `metadata.count` — it is present on every page, including an empty page past the end, which is how paging past the end is told apart from an empty match.
- The `$` OData param prefix must be URL-encoded as `%24` — Akamai's Drupal layer at fema.gov rejects dollar-sign params in GET query strings unless percent-encoded.
- 400 errors return JSON: `{"error":[{"name":"...", "code":"OF_OQP_002", "type":"$filter criteria error", "message":"..."}]}`. `type` names the failing clause (`$filter`, `$select`, `$orderby`); raw parser errors carry neither `code` nor `type` (`{"error":[{"name":"Error","message":"Fail at 0"}]}`).
- Each dataset is served at its own API version (`/api/open/v1`–`/v4`); a wrong version returns the HTML 404 page. The `OpenFemaDataSets` v1 catalog lists every dataset's `version` and `webService` URL.
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
| `OpenFemaService` | OpenFEMA REST API (`https://www.fema.gov/api/open/v<N>/`, version per dataset) | All tools |
| `CanvasService` (framework) | DuckDB via `core.canvas` | `fema_search_nfip`, `fema_dataframe_query`, `fema_dataframe_describe` |

`OpenFemaService` encapsulates the `%24`-encoded OData parameter building, pagination, error-shape detection (JSON 400 vs HTML 404), and retry logic. The convenience fetchers pin their entity and version (`DisasterDeclarationsSummaries` v2, `PublicAssistanceFundedProjectsDetails` v2, `HousingAssistanceOwners`/`Renters` v2, `NfipClaims` v3); `fetchDataset` (used by `fema_query_dataset`) resolves the version from the catalog.

**Catalog cache.** One request to `v1/OpenFemaDataSets?$select=name,version,webService&$top=1000`, keyed on the `webService` path segment (so `OpenFemaDataSetFields` resolves, though its catalog `name` is `DataSetFields`), highest listed version per entity. The map lives in-process for 6 hours; concurrent callers share one in-flight refresh; a refresh is a single attempt with no retries. A failed refresh keeps serving the previous map and tries again after 5 minutes; with no map yet, the call fails `catalog_unavailable` and the next call tries again.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CANVAS_PROVIDER_TYPE` | No | Set to `duckdb` to enable DataCanvas for NFIP analytics. Without it, `fema_search_nfip` inlines results up to the cap and omits `canvas_id`. |
| `FEMA_BASE_URL` | No | Override the API root (default: `https://www.fema.gov/api/open`); each dataset's `/v<N>` is appended per request, and a trailing `/v<N>` on the override is dropped. Useful for test environments. |
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
| NFIP Claim | `NfipClaims` (v3) | `state`, `countyCode`, `reportedZipCode`, `dateOfLoss`, `yearOfLoss`, `amountPaidOnBuildingClaim`, `amountPaidOnContentsClaim`, `buildingDamageAmount`, `contentsDamageAmount`, `ratedFloodZone`, `causeOfDamage`, `occupancyType` | ~2.7M rows total |
| NFIP Policy | `NfipPolicies` (v3) | `propertyState`, `reportedZipCode`, `censusGeoid`, `ratedFloodZone`, `policyEffectiveDate`, `policyTerminationDate`, `totalBuildingInsuranceCoverage`, `totalContentsInsuranceCoverage`, `totalInsurancePremiumOfThePolicy`, `policyCount` | Very large (~millions) |

---

## Workflow Analysis

**`fema_search_nfip` — NFIP claims with analytical spillover**

| # | Call | Purpose | Condition |
|:--|:-----|:--------|:----------|
| 1 | `GET v3/NfipClaims?$filter=...&$top=N&$inlinecount=allpages` | Fetch filtered page of claims | always |
| 2 | `spillover(rows, canvas)` | Stage full result set in DuckDB canvas table | when `canvas` enabled and count > inline cap |
| 3 | Return inline preview + `canvas_id` | Agent sees compact summary; canvas enables SQL | when spilled |

The service layer builds the `$filter` expression from `state`, `county_code`, `zip_code`, and year range. `state` is required — an unfiltered NFIP Claims fetch is 2.7M rows. The response always includes total count from `$inlinecount`. When canvas is disabled, the tool returns the inline page only and notes how to get more via pagination.

---

## Design Decisions

**One tool per dataset group, not one per dataset.** `HousingAssistanceOwners` and `HousingAssistanceRenters` are structurally similar and always queried together for a disaster. A single `fema_get_housing_assistance` with a `type` param (owners/renters/both) is cleaner than two separate tools. Same logic would apply to merging IA sub-datasets.

**NFIP Policies excluded from convenience tools.** `NfipPolicies` times out on state-level queries and uses different field names (`propertyState` instead of `state`, no `countyCode`). Its analytical shape differs from claims — active policy counts, premium amounts, flood zones — but its size and latency make a convenience wrapper dangerous without tight geographic bounds. `fema_query_dataset` is the access path; agents that need policy data provide the filter.

**`DisasterDeclarationsSummaries` returns one row per designated area.** A single declaration for a state yields dozens of rows — one per county or municipality designated. `fema_search_disasters` and `fema_get_disaster` surface this transparently: search returns deduplicated declaration-level summaries with `designatedAreaCount`; get_disaster returns all area rows. The design documents this behavior explicitly so agents aren't surprised.

**DataCanvas for NFIP Claims, not for other datasets.** PA Projects (~1K/disaster) and Housing Assistance (~1K/disaster) fit inline. NFIP Claims is 2.7M rows with a genuinely analytical shape — agents would aggregate by flood zone, year, county, amount buckets. Canvas earns its keep here on both shape (SQL-worthy: GROUP BY, SUM, time-series) and size. PA and housing stay inline.

**`$inlinecount=allpages` on every query.** Without it, `metadata.count` is 0 and the agent can't assess result completeness or tell paging past the end from an empty match. The service sends it on every request; the overhead is minimal.

**`fema_query_dataset` as the long-tail escape hatch.** OpenFEMA has dozens of datasets beyond the headline five. A generic query tool with the full OData parameter set surfaces the rest without a per-dataset tool explosion. The dataset name is looked up in the OpenFEMA dataset catalog, which supplies its API version (datasets range from v1 to v4, and a wrong version 404s); a name missing from the catalog fails before any data request. The Content-Type check before forwarding the response body stays as a backstop.

---

## Known Limitations

- **Akamai blocks un-encoded `$` params.** The service layer must percent-encode `$` as `%24` in all query parameters. This is already the standard behavior of `new URLSearchParams()` in Node/Bun.
- **NFIP Policies is very slow** on anything larger than a ZIP-level query. No convenience tool; documented for `fema_query_dataset` users.
- **`count` is `0` without `$inlinecount=allpages`.** The total is `metadata.count`, which is 0 by default. Always request `$inlinecount=allpages`.
- **HTML 404 on unknown datasets.** The API returns a Drupal HTML error page (not JSON) for unknown dataset names. The service layer detects this via Content-Type and throws a `NotFound` with a clear message.
- **Temporal lag.** NFIP and PA data has reporting delays — recent events may have incomplete records for weeks to months after the disaster.

---

## API Reference

**Base URL:** `https://www.fema.gov/api/open/v{N}/{DatasetName}` — `N` is the dataset's version from the `OpenFemaDataSets` catalog (`https://www.fema.gov/api/open/v1/OpenFemaDataSets`)

**OData query parameters** (must be `%24`-encoded in URL):

| Param | Example | Notes |
|:------|:--------|:------|
| `$filter` | `state eq 'TX' and declarationDate ge '2024-01-01T00:00:00.000Z'` | OData 3 filter syntax. String values in single quotes. Supports `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `and`, `or`, `not`, `substringof`. |
| `$select` | `disasterNumber,declarationTitle,state` | Comma-separated field names. Dramatically reduces payload for large result sets. |
| `$top` | `100` | Max records per page. API default is 1000; no documented hard cap beyond that. |
| `$skip` | `1000` | Offset for pagination. Use `$top + $skip` to page. |
| `$orderby` | `declarationDate desc` | Sort expression. Field + `asc`/`desc`. |
| `$inlinecount` | `allpages` | Only valid value. Returns the total matching count in `metadata.count`. |

**Response envelope:**

Request metadata is nested under `metadata`; the rows sit under a key named for the entity (the `webService` path segment). `metadata.count` is `0` without `$inlinecount=allpages`; send it on every query to get a real total.

```json
{
  "metadata": {
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
    "url": "..."
  },
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
