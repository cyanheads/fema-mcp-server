---
name: fema-guide
description: Gates, identifier sources, and OData syntax for the fema_* tools over OpenFEMA. Use when answering a US federal disaster question (declarations, Public Assistance or housing aid totals, NFIP flood-insurance claims), naming a storm or county across FEMA datasets, or writing a fema_query_dataset filter for a dataset the other tools don't cover.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

OpenFEMA, keyless: disaster declarations, Public Assistance (PA) funded projects, Individuals and Households Program (IHP) housing aid by county and ZIP, NFIP flood-insurance claims, and every other dataset in the OpenFEMA catalog through `fema_query_dataset`. It records what FEMA declared, obligated, approved, and paid. It does not hold hazard measurements or losses outside FEMA programs.

Records for recent disasters are incomplete. In `FemaWebDisasterSummaries`, null PA totals with a null `paLoadDate` mean either PA not yet loaded (the newest declarations) or PA never declared (DR-1689); check `paProgramDeclared` on `DisasterDeclarationsSummaries` before calling it pending. Neither case is $0. Cite the as-of date: `paLoadDate`, `iaLoadDate`, or a row's `lastRefresh`.

## Identifiers

| Identifier | Where it comes from |
|:--|:--|
| Disaster number | `fema_search_disasters`, or a title search (below). The DR/EM/FM label is the declaration type; the number alone is the key every assistance dataset joins on. |
| 5-digit county FIPS | `matched_areas` from `fema_search_disasters` with a county set, or `designated_areas` from `fema_get_disaster`: state code + county code (`48` + `201`). A `Statewide` area carries county code `000`; it is not a county. |
| County name | Stored differently per dataset (table below). |
| Dataset name | `fema_query_dataset` on dataset `DataSets` (fields `name`, `version`, `title`). Names are case-sensitive. |
| Field names and types | `fema_query_dataset` on dataset `DataSetFields`, filtered by `openFemaDataSet` and `datasetVersion`. |

One storm usually means several declarations: one per state, often an EM before the DR. A `HARVEY` title search returns DR-4332 (TX), DR-4345 (LA), and EM-3382 (LA), plus the unrelated FM-2697 HARVEYTOWN FIRE. `fema_search_disasters` has no title filter, so to find a storm by name, either search by state and a declaration-date window, or call `fema_query_dataset` on `DisasterDeclarationsSummaries` with `substringof('HARVEY', declarationTitle)`. Titles are stored upper-case. Incident types don't always match the storm's name: Tropical Storm Allison (DR-1379) is filed as `Coastal Storm`.

| Dataset | County stored as |
|:--|:--|
| Declarations (`designatedArea`), housing | `Harris (County)`, `Acadia (Parish)` |
| PA funded projects | `Harris County`; state-agency applicants as `Statewide` |
| `PublicAssistanceFundedProjectsSummaries` | `Aransas County`, with `state` as the full name (`Texas`) |
| NFIP claims | 5-digit FIPS `countyCode` (`48201`), no name |

## Gates

- **Pass the bare county name** (`Harris`, `harris`) to the county filters of `fema_search_disasters`, `fema_get_public_assistance`, and `fema_get_housing_assistance`. A name carrying another dataset's suffix matches nothing: `Harris County` returns no declarations and no housing records, and `Harris (County)` returns no PA projects. Each of these comes back as a zero-match notice, never an error. The bare name also matches its substring siblings (Harrison), so check `matched_areas` or each row's county and drop those before you total anything.
- **County PA totals leave out `Statewide` projects.** DR-4332 has 734 of them, filed under state agencies rather than a county. When you report a county figure, say it excludes them.
- **Don't conclude "no IA" from `ia_declared`.** It reflects the Individuals and Households Program flag only, and FEMA's two flags disagree in both directions: older declarations, as late as DR-1689 (2007), can carry IA without IHP, so they show `ia_declared: false` and a program line without IA (DR-1379 reads `PA, HM`, DR-1689 reads `HM`), while some recent ones carry IHP without IA (DR-4953). The housing tools hold nothing earlier than DR-1439 (declared 2002-11-05). When the question is whether IA was declared, run `fema_query_dataset` on `DisasterDeclarationsSummaries`, select both `iaProgramDeclared` and `ihProgramDeclared`, and report what each says.
- **No tool sums dollars.** For one disaster's totals, use `fema_query_dataset` on `FemaWebDisasterSummaries`, filtered `disasterNumber eq <n>`. It returns IHP approved (housing + other needs), PA obligated in total and for categories A–B and C–G (the total also covers other categories, so the two sub-totals sum to less), and HMGP. For a county or applicant breakdown, page the projects or housing records to the end with `next_offset` before you report a sum. Pages are bounded by characters, so a `fema_query_dataset` call that selects only the amount fields fits more rows per page than the curated tools do.
- **NFIP claims carry no disaster number.** Scope them by state, county FIPS, and loss year. To tie claims to a named event, run `fema_query_dataset` on `NfipClaims` with `floodEvent eq 'Hurricane Harvey'`, keeping state and `countyCode` in the same filter. `fema_search_nfip` doesn't expose `floodEvent`.
- **Size an NFIP query before you aggregate it.** Compare `total_count` with the canvas row cap named in `fema_search_nfip`'s description; Harris County's Harvey claims alone come to about 49,000. When a match runs past the cap, split it by year range, stage each range onto the same canvas, and combine the tables in SQL with `UNION ALL`. Only a call at offset 0 stages.
- **Group flood zones deliberately.** `rated_flood_zone` mixes current codes (`AE`, `VE`, `X`) with legacy ones (`A01`–`A30`, `V`-numbered, `B`, `C`) and nulls. By FEMA's definitions, every A and V code is the Special Flood Hazard Area (the 100-year floodplain), `B` is moderate hazard, and `C` is minimal hazard. `X` alone doesn't tell you whether a zone is moderate or minimal.
- **A null claim amount means unrecorded, not $0.** SUM skips nulls, so use `COUNT(amount_paid_building)` to count the claims behind a building-payment sum, not `COUNT(*)`.
- **Run heavy calls one at a time.** OpenFEMA rate-limits large-dataset queries with HTTP 429 and a `retryAfter` (60 s); wait it out before retrying. NFIP reads sometimes time out upstream, and the same call can succeed when retried. Don't read a timeout as an empty match.

## OData for `fema_query_dataset`

| Need | Write |
|:--|:--|
| Text | `state eq 'TX'`: single quotes, exact case |
| Number, boolean | `disasterNumber eq 4332`, `ihProgramDeclared eq true`: unquoted |
| Date | `declarationDate ge '2017-01-01'`, or a full `'2017-01-01T00:00:00.000Z'` |
| Value list | `disasterNumber in (4332,1379)`, `openFemaDataSet in ('NfipClaims','NfipPolicies')` |
| Substring | `substringof('Harris', designatedArea)`: needle first, field second |
| NFIP county | `countyCode eq '48201'`: a quoted 5-digit string |

`eq` and `substringof` are case-sensitive, and OpenFEMA has no function that folds case. A wrong-case value returns zero rows rather than an error: `state eq 'tx'` and `substringof('harris', designatedArea)` both match nothing. Take the spelling from a row you've already read.

Field names differ between datasets: `stateAbbreviation` on PA project details, `propertyState` on `NfipPolicies`, a full state name on `PublicAssistanceFundedProjectsSummaries`. Read `DataSetFields` (or one row with limit 1) before you write the filter. Scope `NfipClaims` by state plus `countyCode` or `reportedZipCode`, as `fema_search_nfip` does.

## Workflows

**Money for a disaster.** Find the disaster number. For headline figures, use `FemaWebDisasterSummaries`. For a county, filter `fema_get_public_assistance` and `fema_get_housing_assistance` with the bare county name, drop sibling counties, page to the end, and sum. Report which PA amount you summed; the tool's field descriptions define each one.

**Flood claims for an area.** Get the 5-digit FIPS from the declaration tools. Call `fema_search_nfip` with state, county, and year range at offset 0, then aggregate on the canvas. For a single named event, filter `floodEvent` through `fema_query_dataset` instead.

**A dataset the curated tools don't cover.** List candidates from `DataSets` with `substringof` on `name`, read the dataset's fields from `DataSetFields`, read one row, then filter.

A `fema_search_nfip` match too large to return inline is staged as a DataCanvas table, and the response carries a `canvas_id`; no other tool stages. Call `fema_dataframe_describe` with it for the staged table and column names before writing SQL, then `fema_dataframe_query` with a read-only query. Pass the same `canvas_id` back to `fema_search_nfip` to stage further results beside the first. A `canvas_id` that has expired returns `canvas_not_found`; re-run `fema_search_nfip` to stage the data again.
