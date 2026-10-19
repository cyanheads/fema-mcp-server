# FEMA MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `fema_search_disasters` | Search federal disaster declarations by state, incident type, declaration type, date range, and county. Returns deduplicated declaration-level summaries — disaster number (chain key for PA/IA tools), title, state, incident type, dates, programs declared (IA/PA/HM), and `designated_area_count`. The primary entry point — "what disasters were declared in Texas in 2025?" | `state` (2-letter), `incident_type` (case-insensitive substring), `declaration_type` (enum: `DR`/`EM`/`FM`), `date_from`, `date_to`, `county` (case-insensitive substring), `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |
| `fema_get_disaster` | Fetch up to 1,000 designated-area rows for a specific disaster, with program evidence, incident period, and county breakdowns. Discloses partial coverage and the upstream total when capped. Chains to PA and housing assistance tools via the disaster number. | `disaster_number` | `readOnlyHint: true`, `openWorldHint: false` |
| `fema_get_public_assistance` | Public-assistance funded projects for a disaster or state — where federal recovery money went. Returns applicant, damage category, project size/status, federal share obligated, and total obligated. Requires `disaster_number` or `state`. | `disaster_number`, `state`, `county` (case-insensitive substring), `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |
| `fema_get_housing_assistance` | Individual-assistance housing data for a disaster. Returns IA housing grants by county/ZIP — owner and renter breakdowns, valid registrations, total approved IHP amounts, repair/rental/other-needs amounts, and inspection counts (owners add inspected damage in USD, renters damage-degree counts). Covers HousingAssistanceOwners and HousingAssistanceRenters datasets; `state`, `county`, and `zip_code` filter both before paging. | `disaster_number`, `state`, `county` (case-insensitive substring), `zip_code` (5 digits), `type` (owners/renters/both), `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |
| `fema_search_nfip` | National Flood Insurance Program claims for a state, county, or ZIP. Returns the match count and claim records — amounts paid on building and contents claims, damage estimates, flood zones, cause and occupancy codes, loss dates — newest loss first, paged by `limit`/`offset` within a 100,000-character inline budget. A match over that budget is staged on a DataCanvas table for SQL-based aggregation. Requires at least `state`. | `state`, `county_code`, `zip_code`, `year_from`, `year_to`, `limit`, `offset`, `canvas_id` | `readOnlyHint: true`, `openWorldHint: true` |
| `fema_dataframe_query` | Run a SELECT query against a DataCanvas table previously staged by `fema_search_nfip`. Enables aggregation, grouping, and time-series analysis over the full NFIP dataset without re-fetching. | `canvas_id`, `query` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `fema_dataframe_describe` | List columns and row count for a DataCanvas table staged by `fema_search_nfip`. Use before `fema_dataframe_query` to discover the schema. | `canvas_id` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `fema_query_dataset` | Generic OData query against any dataset in the OpenFEMA dataset catalog, at the API version the catalog lists for it — the escape hatch for datasets the convenience tools don't cover (NfipPolicies, IndividualAssistanceHousingRegistrantsLargeDisasters, etc.). Accepts raw `$filter`, `$select`, `$orderby`, and pagination params. | `dataset`, `filter`, `select`, `orderby`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |

### Error Contracts

Domain failures each definition declares in `errors[]` (baseline codes — `InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError` — also bubble undeclared). Input-schema rejections — a missing required field, an out-of-range `limit`, a `date_from` that is not a `YYYY-MM-DD` calendar date — never reach a handler: they arrive as the framework's `invalid_arguments` reason with code `InvalidParams` and are not listed here. A check a caller is expected to recover from — a reversed range, a malformed `county_code` — runs in the handler instead, so its declared reason and recovery reach the wire; a schema-level check would make that entry unreachable.

Paging past the end is never an error. The four curated searches and `fema_query_dataset` return an empty page with totals and a `notice` naming the last valid offset when the total is nonzero. A zero-match search instead returns empty arrays, zero totals, and guidance based on supplied filters, at any offset, without a next offset or last-valid-offset claim. Identifier-only assistance calls suggest checking programs with `fema_get_disaster`; the generic query suggests checking field names and filter syntax. NFIP acquires no canvas for either empty case. None of these searches declares `no_results`.

An NFIP `county_code` search starts one parallel count-only exchange for `countyCode eq null`, using only the same state and year bounds, `$top=1`, `$select=countyCode`, and `$inlinecount=allpages`. It has no retries and a two-second deadline covering the response body. The primary read's completion snapshots the count and aborts unfinished coverage work, before canvas work starts. A positive count adds state/year-scoped disclosure and a qualified ZIP workaround, never a county or ZIP allocation; zero adds nothing. Failed or unfinished coverage is disclosed as unchecked. Cancellation still rejects, programmer faults still fail, and all coverage text composes with empty, paging, budget, and canvas notices.

Every row-returning tool holds a page to 100,000 characters of rows on each surface (`src/mcp-server/tools/response-budget.ts`), charging each row the larger of its JSON and the text `format()` renders for it, plus a separator. A page is cut only between whole rows and always holds at least one. `fema_query_dataset`, `fema_get_public_assistance`, `fema_get_housing_assistance`, `fema_search_disasters`, and `fema_search_nfip` add `next_offset` (`offset` plus the rows returned) whenever matching rows remain, with a `notice` naming it and saying whether the budget or `limit` ended the page; housing cuts owners and renters at one row count, so one `offset` continues both. `fema_search_nfip` keeps its own measure (claim JSON) and its notice wording, and sets `next_offset` after a spill as well. `fema_dataframe_query`, which takes no offset, sets `truncated` and `shown` on a budget cut, and `cap` only when the canvas row limit applied; its notice says to advance the query's `OFFSET` by `shown` under an `ORDER BY`, lowering any `LIMIT` by the same amount so the pages stay inside the rows that `LIMIT` selected.

`fema_search_disasters` pages declarations within the most recent 10,000 designated-area rows. When more rows match, it drops every row dated on the window's oldest day: all rows of a declaration share one `declarationDate`, so each returned declaration is complete, and the window is exactly the matches dated after that day. The response sets `truncated: true`, `format()` and the trailer word the declaration totals as lower bounds, and the `notice` names `date_to=<that day>` (inclusive through `23:59:59.999Z`), which continues with no gap or overlap. `next_offset` pages within that window. On an empty page past the end, that notice and the last-valid-offset sentence compose into one `notice`.

With `county` set, `fema_search_disasters` reads the page's full area rows in a second request (`disasterNumber in (…)`, paged past 10,000 rows) so `designated_area_count` and the program flags describe the whole declaration, while the matched rows supply `matched_areas` and `total_area_rows`. The read covers every declaration `limit` selects and runs before the budget cut, because the corrected counts and flags change what each declaration costs. A full page of 1,000 four-digit disaster numbers is one ~7,200-character URL; the list splits into more requests only past 7,500 encoded characters. The main search and this read share one 50-second budget, which bounds the main request too, and the first page of the read to fail aborts the pages in flight beside it. The read is a best-effort correction: when it fails or the budget is spent, the response keeps the matched-area values, sets `area_totals_unavailable: true`, and its `notice` names the cause in caller terms (a timeout inside the budget, an HTTP 429, another HTTP status, or no usable response — never service internals or the request URL); a cancelled request still ends as cancelled.

Every `fema_dataframe_query` reason but `canvas_unavailable` is thrown by the framework's canvas — `acquire()`, the SQL gate, or the DuckDB engine — and arrives with the framework's own recovery hint, which a declared `recovery` never replaces. The tool declares them, marked `thrownBy: 'service'`, so `tools/list` advertises what the call can return; it does not catch and re-raise them.

| Definition | `reason` | Code | When |
|:-----|:---------|:-----|:-----|
| `fema_search_disasters` | `invalid_state` | `ValidationError` | `state` is not a valid 2-letter US state/territory code |
| `fema_search_disasters` | `invalid_range` | `ValidationError` | `date_from` is later than `date_to`; fails before any request. Equal dates select one day |
| `fema_search_disasters` | `request_too_long` | `ValidationError` | An `incident_type` or `county` value long enough to push the request URL past the roughly 8,900 characters OpenFEMA's CDN accepts |
| `fema_get_disaster` | `not_found` | `NotFound` | No declaration has the number; a number above 32767 (OpenFEMA's Int16 limit) fails before any request |
| `fema_get_public_assistance` | `invalid_state` | `ValidationError` | `state` is not a valid 2-letter US state/territory code |
| `fema_get_public_assistance` | `missing_filter` | `ValidationError` | Neither `disaster_number` nor `state` was provided |
| `fema_get_public_assistance` | `not_found` | `NotFound` | `disaster_number` is above 32767 — fails before any request, with `fema_get_disaster`'s recovery |
| `fema_get_public_assistance` | `request_too_long` | `ValidationError` | A `county` value long enough to push the request URL past the roughly 8,900 characters OpenFEMA's CDN accepts |
| `fema_get_housing_assistance` | `invalid_state` | `ValidationError` | `state` is not a valid 2-letter US state/territory code |
| `fema_get_housing_assistance` | `not_found` | `NotFound` | `disaster_number` is above 32767 — fails before either dataset is fetched, with `fema_get_disaster`'s recovery |
| `fema_get_housing_assistance` | `request_too_long` | `ValidationError` | A `county` value long enough to push the request URL past the roughly 8,900 characters OpenFEMA's CDN accepts |
| `fema_search_nfip` | `invalid_state` | `ValidationError` | `state` is not a valid 2-letter US state/territory code |
| `fema_search_nfip` | `invalid_county_code` | `ValidationError` | `county_code`, trimmed, is not 1–5 digits, or is a 1–3-digit county part for a state with no FIPS code (FM, MH, PW); fails before any request |
| `fema_search_nfip` | `invalid_range` | `ValidationError` | `year_from` is later than `year_to`; fails before any request. Equal years select one year |
| `fema_dataframe_query` | `canvas_unavailable` | `ServiceUnavailable` | DataCanvas is disabled on this deployment (`CANVAS_PROVIDER_TYPE` is not `duckdb`) |
| `fema_dataframe_query` | `canvas_not_found` | `NotFound` | `canvas_id` names no active canvas session |
| `fema_dataframe_query` | `missing_table` | `NotFound` | The SELECT names a table not staged on the canvas — misspelled, dropped, or expired |
| `fema_dataframe_query` | `invalid_sql` | `ValidationError` | A SELECT fails to prepare: an unknown column, function, or type, or an invalid expression |
| `fema_dataframe_query` | `non_select_statement` | `ValidationError` | Not a SELECT (DDL, DML, `PRAGMA`, `EXPLAIN`, `ATTACH`), or SQL that does not parse |
| `fema_dataframe_query` | `multi_statement` | `ValidationError` | More than one SQL statement |
| `fema_dataframe_query` | `denied_function` | `ValidationError` | A file reader, an engine-setting reader (`current_setting`), or `query()`/`query_table()` over anything but one literal SELECT |
| `fema_dataframe_query` | `plan_operator_not_allowed` | `ValidationError` | A plan operator outside the read-only allowlist — a table function such as `range()`, or a system catalog such as `information_schema` |
| `fema_dataframe_query` | `sql_read_only` | `ValidationError` | The statement writes or names a file (`COPY … TO`, a quoted file path in `FROM`) |
| `fema_dataframe_query` | `sql_execution_error` | `ValidationError` | The SELECT fails while converting or calculating values in the staged data |
| `fema_dataframe_describe` | `canvas_unavailable` | `ServiceUnavailable` | DataCanvas is disabled on this deployment |
| `fema_dataframe_describe` | `canvas_not_found` | `NotFound` | `canvas_id` names no active canvas session |
| `fema_dataframe_drop` | `canvas_unavailable` | `ServiceUnavailable` | DataCanvas is disabled on this deployment |
| `fema_dataframe_drop` | `canvas_not_found` | `NotFound` | `canvas_id` names no active canvas session |
| `fema_query_dataset` | `unknown_dataset` | `NotFound` | The dataset name is not in the OpenFEMA dataset catalog (no data request is made); a case-only mismatch names the catalog spelling |
| `fema_query_dataset` | `dataset_not_served` | `NotFound` | The catalog lists the dataset, but OpenFEMA answers its API endpoint with the HTML 404 page (e.g., `PublicAssistanceProjectsStatus`), or the version is past its deprecation date and answers with its old count and no records (e.g., `HazardMitigationAssistanceProjects` v4 after 2026-10-15; the message and recovery name the replacement dataset, `HmaSubapplications`, when the catalog lists the page OpenFEMA links as the replacement, and otherwise that page). Raised only on this tool's path; the convenience tools' pinned datasets keep `unknown_dataset` |
| `fema_query_dataset` | `catalog_unavailable` | `ServiceUnavailable` | The dataset catalog could not be read and no earlier copy is cached — retryable |
| `fema_query_dataset` | `invalid_filter` | `ValidationError` | OpenFEMA 400 with `type: "$filter criteria error"` (unknown field, wrong value type, out-of-range integer, a quoted value that is not a date or GUID), or an untyped parser error when `filter` was the only expression sent |
| `fema_query_dataset` | `invalid_select` | `ValidationError` | OpenFEMA 400 with `type: "$select criteria error"`, or an untyped parser error when `select` was the only expression sent |
| `fema_query_dataset` | `invalid_orderby` | `ValidationError` | OpenFEMA 400 with `type: "$orderby criteria error"`, or an untyped parser error when `orderby` was the only expression sent |
| `fema_query_dataset` | `invalid_odata_syntax` | `ValidationError` | Untyped parser error (`{"name":"Error","message":"Fail at 0"}`) with several expressions sent — OpenFEMA does not say which failed |
| `fema_query_dataset` | `request_too_long` | `ValidationError` | The CDN answers a request URL longer than about 8,900 characters with an HTML 400 before OpenFEMA sees it; the service reads an HTML 400 for a URL over 8,000 characters as this, never as a missing endpoint |
| `fema_query_dataset` | `filter_too_complex` | `ValidationError` | OpenFEMA 400 `OF_OQP_000` "maximum nesting depth of 100 exceeded" — every `and`/`or` and parenthesized group adds a level, so about 90 chained comparisons is the most one filter holds; `field in (…)` takes a value list in one level |
| `fema://disaster/{disasterNumber}` | `not_found` | `NotFound` | The number is malformed (anything but digits), outside 1–32767 — neither reaches OpenFEMA — or matches no declaration; resource errors carry the reason and recovery on the JSON-RPC `error.data` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `fema://disaster/{disasterNumber}` | Summary from up to 500 designated-area rows — title, state, incident type, programs, incident period, with totals and partial-coverage disclosure when capped. | No; use `fema_query_dataset` for full rows |

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
- A request URL past about 8,900 characters gets the CDN's own HTML 400 ("Bad Request", `server: AkamaiGHost`) at any endpoint, an unknown or unserved one included; below that length an unknown or unserved endpoint answers 404 (measured 2026-10-16: refused between 8,909 and 8,912 characters, the cutoff moving with the request's headers).
- A `$filter` nested more than 100 levels deep returns JSON 400 `OF_OQP_000`, `type: "Unknown error"`, "Query too complex - maximum nesting depth of 100 exceeded". An `or` chain of 93 comparisons passes and 94 fails; each enclosing `and` operand and parenthesized group costs one more level (measured 2026-10-16).
- String functions (`substringof`, `startswith`, `endswith`, `contains`) are case-sensitive, and OpenFEMA has no case-folding function — `tolower`/`toupper` return HTTP 400.
- `DisasterDeclarationsSummaries` returns one row per designated area per disaster, not one row per disaster. Grouping or `disasterNumber` filtering is needed to work at the declaration level. A filter on `designatedArea` returns only the matching areas' rows, and program flags differ by area (12 of DR-4332's 53 areas carry PA and HM without IHP), so declaration-level counts and flags need the declaration's full rows. `disasterNumber in (…)` accepts a 1,000-number list in one request (7,230-character URL, ~1.2 s for 10,000 rows; measured 2026-10-16, highest disaster number 5678).
- NFIP Policies uses `propertyState` not `state` as the state field.
- NFIP Claims uses `countyCode` (camelCase) in the OData filter; the tool's snake_case input param `county_code` must be mapped to `countyCode` in the filter expression builder. The dataset stores only 5-digit state+county codes, so any other form matches nothing; 3 claims nationally carry a code whose state prefix disagrees with `state` (TX `22029`, MN `46109`; measured 2026-10-16), which is why such a code is sent rather than rejected.
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

**Catalog cache.** One request to `v1/OpenFemaDataSets?$select=name,version,webService&$top=1000`, keyed on both the `webService` path segment and the catalog `name`, highest listed version per key. OpenFEMA serves both: `OpenFemaDataSetFields` and `DataSetFields` (its catalog `name`). `OpenFemaDataSets` itself resolves at v1, although the catalog lists itself as `DataSets`. The map lives in-process for 6 hours; concurrent callers share one in-flight refresh; a refresh is a single attempt with no retries. A failed refresh keeps serving the previous map and tries again after 5 minutes; with no map yet, the call fails `catalog_unavailable` and the next call tries again.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CANVAS_PROVIDER_TYPE` | No | Set to `duckdb` to enable DataCanvas for NFIP analytics. Without it, `fema_search_nfip` returns inline pages only (paged by `offset`) and omits `canvas_id`. |
| `FEMA_BASE_URL` | No | Override the API root (default: `https://www.fema.gov/api/open`); each dataset's `/v<N>` is appended per request, and a trailing `/v<N>` on the override is dropped. Useful for test environments. |
| `FEMA_REQUEST_TIMEOUT_MS` | No | HTTP request timeout in milliseconds (default: 30000). NFIP county queries can be slow. |

---

## Implementation Order

1. **Config and service setup** — `src/config/server-config.ts`, `OpenFemaService` with OData param builder, response parser, error classifier, and retry wrapper.
2. **`fema_search_disasters`** — primary tool over `DisasterDeclarationsSummaries`. Groups or presents per-area rows.
3. **`fema_get_disaster`** — single disaster by number, up to 1,000 designated areas with completeness disclosure.
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
| Housing Assistance (Renter) | `HousingAssistanceRenters` | `disasterNumber`, `state`, `county`, `city`, `zipCode`, `validRegistrations`, `totalInspected`, `totalInspectedWithNoDamage`, `totalWithModerateDamage`, `totalWithMajorDamage`, `totalWithSubstantialDamage`, `approvedForFemaAssistance`, `totalApprovedIhpAmount`, `repairReplaceAmount`, `rentalAmount`, `otherNeedsAmount`, `totalMaxGrants` — no dollar damage fields (`totalDamage`, `averageFemaInspectedDamage`, `noFemaInspectedDamage` are owner-only); the degree counts are registrations and can exceed `totalInspected` | ~1K/disaster |
| NFIP Claim | `NfipClaims` (v3) | `state`, `countyCode`, `reportedZipCode`, `dateOfLoss`, `yearOfLoss`, `amountPaidOnBuildingClaim`, `amountPaidOnContentsClaim`, `buildingDamageAmount`, `contentsDamageAmount`, `ratedFloodZone`, `causeOfDamage`, `occupancyType` | ~2.7M rows total |
| NFIP Policy | `NfipPolicies` (v3) | `propertyState`, `reportedZipCode`, `censusGeoid`, `ratedFloodZone`, `policyEffectiveDate`, `policyTerminationDate`, `totalBuildingInsuranceCoverage`, `totalContentsInsuranceCoverage`, `totalInsurancePremiumOfThePolicy`, `policyCount` | Very large (~millions) |

---

## Workflow Analysis

**`fema_search_nfip` — NFIP claims with analytical spillover**

| # | Call | Purpose | Condition |
|:--|:-----|:--------|:----------|
| 1 | `GET v3/NfipClaims?$filter=...&$select=<12 fields>&$orderby=dateOfLoss desc,id&$top=N&$skip=M&$inlinecount=allpages` | Fetch one ordered page of claims: `$skip=offset`, `$top=limit` (capped at the 409 rows that could fit the budget) without canvas or at an `offset` above 0; `$skip=0`, `$top=5000` with canvas at `offset` 0 | always |
| 2 | Measure the page against the 100,000-character budget | Canvas enabled at `offset` 0: a match that is whole in the first page and fits returns its first `limit` claims with no canvas | always |
| 3 | `canvas.acquire()` + `spillover(first page + later pages)` | Stage the match (up to 50,000 rows) in a DuckDB canvas table | canvas enabled, `offset` 0, and the first page proves the match overflows the budget |
| 4 | Return the inline page, plus `canvas_id`/`canvas_table`/`staged_count` when staged | Agent sees a compact page; the canvas holds the rest for SQL | always |

The tool builds the `$filter` expression from `state`, `county_code`, `zip_code`, and year range. `state` is required — an unfiltered NFIP Claims fetch is 2.7M rows. `total_count` is OpenFEMA's `$inlinecount`, on every path. `next_offset` names the next inline page whenever claims remain past this one, after a spill too. One `notice` covers the response: the offset to continue from when an unstaged page left claims out, the last valid offset when `offset` is past the end, or, after a spill, the canvas table with `fema_dataframe_describe` and then `fema_dataframe_query` (rows past the inline claims are read from the table). A minted canvas is dropped when staging fails or the request is aborted; a caller-supplied `canvas_id` is never dropped.

---

## Design Decisions

**One tool per dataset group, not one per dataset.** `HousingAssistanceOwners` and `HousingAssistanceRenters` are structurally similar and always queried together for a disaster. A single `fema_get_housing_assistance` with a `type` param (owners/renters/both) is cleaner than two separate tools. Same logic would apply to merging IA sub-datasets.

**NFIP Policies excluded from convenience tools.** `NfipPolicies` times out on state-level queries and uses different field names (`propertyState` instead of `state`, no `countyCode`). Its analytical shape differs from claims — active policy counts, premium amounts, flood zones — but its size and latency make a convenience wrapper dangerous without tight geographic bounds. `fema_query_dataset` is the access path; agents that need policy data provide the filter.

**`DisasterDeclarationsSummaries` returns one row per designated area.** A single declaration for a state yields dozens of rows. Search returns deduplicated declaration summaries; `fema_get_disaster` reads at most 1,000 rows, and the disaster resource reads at most 500. Both preserve fetched `designated_area_count` and OR program flags across fetched rows. When the upstream count exceeds those rows, additive `areas_truncated`, `total_designated_area_count`, and a notice disclose partial program evidence and direct callers to `fema_query_dataset`; false flags or an empty program list cannot establish absence across unfetched rows. Keeping the single reads bounds detail latency. A `county` search separately reads the returned page's full rows and reports matching areas in `matched_areas`, so its declaration counts and flags retain their meaning.

**DataCanvas for NFIP Claims, not for other datasets.** PA Projects (~1K rows/disaster, up to 6,616 for DR-4332) and Housing Assistance (~1K rows/disaster) are not staged: a page of either is held to the 100,000-character response budget and continued by `next_offset`, so their size never calls for a canvas, and their shape is find-and-read rather than aggregate. NFIP Claims is 2.7M rows with a genuinely analytical shape — agents would aggregate by flood zone, year, county, amount buckets. Canvas earns its keep here on both shape (SQL-worthy: GROUP BY, SUM, time-series) and size. PA and housing stay inline.

**Inline pages are bounded by characters, not rows.** A `limit` cannot bound a response: rows range from tens of characters to kilobytes (a 10,000-row `fema_query_dataset` page with no `select` measured 18 MB), so every row-returning tool cuts its page at 100,000 characters of rows, charging each row what the larger of its two surfaces costs, and reports the continuation as a plain `next_offset` beside the existing `offset` input. PA and housing `limit` rise to 10,000 to match `fema_query_dataset` and `fema_search_nfip`, since the budget, not the row count, is what keeps a page small; `fema_search_disasters` keeps 1,000, the most declarations whose numbers fit one follow-up URL. Rejected: smaller `limit` defaults (they still allow megabyte responses, and a row count does not bound wide rows), and separate owner and renter offsets for housing (two inputs that an aligned cut makes unnecessary).

**`fema_query_dataset` reads a page in chunks, not at `limit`.** Its records have no known size: an `IpawsArchivedAlerts` record runs to ~10,000 characters, so a `$top` of 10,000 read 95 MB and raised the process's RSS by ~580 MB to keep the 9 records that fit, on every page of a walk. The first read asks for at most 500 records (the default `limit` of 100 stays one request); while the page is still under the budget and `limit`, up to two more reads ask for as many records as the remaining budget holds at the average charge read so far. The reads past the first share one 50-second deadline and are best-effort: when one fails, the page keeps what was read and `next_offset` continues from it. PA and housing cap `$top` by their smallest possible row instead, since their row shape is fixed.

**NFIP pages by `offset`; a canvas only for a match over the inline budget.** Every NFIP request orders by `dateOfLoss desc,id` (dates alone tie, up to 43 claims on one date in a county-year) and selects the 12 fields the tool reads, which cuts a 5,000-row page from ~12 MB to ~1.5 MB. A match that fits the 100,000-character budget arrives whole in the first 5,000-row page, so the tool decides before acquiring anything: forcing a spill to page a few hundred rows would spend a DuckDB instance and a tenant canvas slot on data that fits inline, and canvas-disabled deployments need `offset` regardless. Both deployments bound inline pages by the same character budget. Only a call at `offset` 0 stages: a later offset reads just its own page, so paging through a staged match never drains it again or takes another canvas slot.

**Case-insensitive name filters resolve against a bundled vocabulary.** `name-matcher.ts` finds exact-case occurrences of trimmed input in declaration `designatedArea` and PA `county` values, plus derived `<name> <type>` declaration forms. Incident types resolve against declaration `incidentType` values. Each filter sends those spellings plus the input, lower, UPPER, and Title Case fallbacks as `or`-joined `substringof` clauses. This preserves substring semantics and upstream paging with no runtime lookup, including PA names such as `LaSalle Parish` and `Chugach REAA` that differ from declaration names. Search, PA, and housing share the matcher; housing applies its filter to both datasets before paging. Fixed variants alone miss stored mixed-case names; enumerating case permutations would exceed OpenFEMA's nesting limit.

`bun run vocabulary:build` downloads both v2 name sources sequentially using OpenFEMA's documented `$allrecords=true`. PA selects only `county` with `county ne null`, covering every row that can contribute a county name and checking the returned count against that filtered total. A complete single response needs no PA sort or paging key; omitting both the sort and hashes reduces refresh time and download size. Both downloads must match their totals. Three transient-only attempts share each source's six-minute deadline; the run has an eight-minute deadline. Only after both sources validate does a formatted temporary file replace `name-vocabulary.ts` atomically. Snapshot tests re-derive the combined vocabulary's spelling bound, including derived declaration forms, to keep filters below OpenFEMA's 100-level nesting limit. The bulk-download parameter is documented in [FEMA's paging tutorial](https://github.com/FEMA/openfema-samples/blob/master/analysis-examples/API_Tutorial_Part_3_PagingToGetData.ipynb).

**`$inlinecount=allpages` on every query.** Without it, `metadata.count` is 0 and the agent can't assess result completeness or tell paging past the end from an empty match. The service sends it on every request; the overhead is minimal.

**`fema_query_dataset` as the long-tail escape hatch.** OpenFEMA has dozens of datasets beyond the headline five. A generic query tool with the full OData parameter set surfaces the rest without a per-dataset tool explosion. The dataset name is looked up in the OpenFEMA dataset catalog, which supplies its API version (datasets range from v1 to v4, and a wrong version 404s); a name missing from the catalog fails before any data request. The Content-Type check before forwarding the response body stays as a backstop.

**One table renderer for arbitrary records.** `fema_query_dataset` and `fema_dataframe_query` return records whose fields the server does not know in advance, so both render `content[]` through `src/mcp-server/tools/markdown-table.ts`: a header from the first record's keys (OpenFEMA returns one key set per page; a SQL result has fixed columns), then one line per record. Each header and data cell goes through one formatter — compact JSON for objects and arrays, `null` for null, `""` for an empty string, `\|` for a pipe (doubling any backslashes directly before it, since GFM parsers read a pipe after an even backslash run as a cell boundary), one space for each CR, LF, or CRLF — so every value `structuredContent` carries appears in the text, and no value can split a cell or a row. Both tools render every page this way at any size: a line's text depends only on its record and the column list, never on how many records the page holds, which is what lets the response budget charge each record its own line. A string whose text is `null` reads the same as null in `content[]`; `structuredContent` is exact.

---

## Known Limitations

- **Akamai blocks un-encoded `$` params.** The service layer must percent-encode `$` as `%24` in all query parameters. This is already the standard behavior of `new URLSearchParams()` in Node/Bun.
- **NFIP Policies is very slow** on anything larger than a ZIP-level query. No convenience tool; documented for `fema_query_dataset` users.
- **`count` is `0` without `$inlinecount=allpages`.** The total is `metadata.count`, which is 0 by default. Always request `$inlinecount=allpages`.
- **HTML 404 on unknown datasets.** The API returns a Drupal HTML error page (not JSON) for unknown dataset names. The service layer detects this via Content-Type and throws a `NotFound` with a clear message.
- **Filter size limits.** Request URLs past about 8,900 characters (`request_too_long`) and filters nested past 100 levels (`filter_too_complex`) are refused upstream; `field in ('a','b')` holds a value list in one level and fewer characters than an `or` chain.
- **Temporal lag.** NFIP and PA data has reporting delays — recent events may have incomplete records for weeks to months after the disaster.

---

## API Reference

**Base URL:** `https://www.fema.gov/api/open/v{N}/{DatasetName}` — `N` is the dataset's version from the `OpenFemaDataSets` catalog (`https://www.fema.gov/api/open/v1/OpenFemaDataSets`)

**OData query parameters** (must be `%24`-encoded in URL):

| Param | Example | Notes |
|:------|:--------|:------|
| `$filter` | `state eq 'TX' and declarationDate ge '2024-01-01T00:00:00.000Z'` | OData 3 filter syntax. String values in single quotes. Supports `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `and`, `or`, `not`, `substringof`. |
| `$select` | `disasterNumber,declarationTitle,state` | Comma-separated field names. Dramatically reduces payload for large result sets. |
| `$top` | `100` | Max records per page. Without it OpenFEMA returns 1,000; it has no 10,000 ceiling (measured 2026-10-16: `DisasterDeclarationsSummaries` with `$select=id` served 10,001, 20,000, and 50,000 rows, `$top=100000` returned all 70,567, and `NfipClaims` answered `$top=10001` and `$top=50000` with HTTP 200). Response time, not a cap, bounds a useful page. |
| `$skip` | `1000` | Offset for pagination. Use `$top + $skip` to page. |
| `$orderby` | `declarationDate desc` | Sort expression. Field + `asc`/`desc`. |
| `$inlinecount` | `allpages` | Only valid value. Returns the total matching count in `metadata.count`. |

**Response envelope:**

Request metadata is nested under `metadata`; the rows sit under a key named for the requested entity (`DataSetFields` for `/v1/DataSetFields`, `OpenFemaDataSetFields` for `/v1/OpenFemaDataSetFields`). `metadata.count` is `0` without `$inlinecount=allpages`; send it on every query to get a real total.

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

**400 (HTML):** The CDN's "Bad Request" page for a request URL past about 8,900 characters — OpenFEMA never sees the request.
