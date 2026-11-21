---
name: fema-guide
description: Gates, identifier sources, and OData syntax for the fema_* tools over OpenFEMA. Use when answering a US federal disaster question (declarations, Public Assistance or housing aid totals, NFIP flood-insurance claims), naming a storm or county across FEMA datasets, or writing a fema_query_dataset filter for a dataset the other tools don't cover.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.2"
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

One storm usually means several declarations: one per state, often an EM before the DR. Call `fema_search_disasters` with `title: "harvey"` for deduplicated declarations: DR-4332 (TX), DR-4345 (LA), and EM-3382 (LA), plus the unrelated FM-2697 HARVEYTOWN FIRE. The title is a case-insensitive substring, not a storm identifier; combine it with state, declaration type, or dates to narrow the match. Incident types don't always match the storm's name: Tropical Storm Allison (DR-1379) is filed as `Coastal Storm`.

| Dataset | County stored as |
|:--|:--|
| Declarations (`designatedArea`), housing | `Harris (County)`, `Acadia (Parish)` |
| PA funded projects | `Harris County`; state-agency applicants as `Statewide` |
| `PublicAssistanceFundedProjectsSummaries` | `Aransas County`, with `state` as the full name (`Texas`) |
| NFIP claims | 5-digit FIPS `countyCode` (`48201`), no name |

## Gates

- **Recognized county suffixes work across datasets.** The county filters of `fema_search_disasters`, `fema_get_public_assistance`, and `fema_get_housing_assistance` recognize terminal County, Parish, Borough, and Census Area forms with or without parentheses: `Harris County` and `Harris (County)` identify the same name/type. Unknown names retain exact/case fallbacks. Bare `Harris` also matches Harrison; check `matched_areas` or each row's county before totaling. A suffixed name keeps its type instead of broadening to the bare substring.
- **County PA totals leave out `Statewide` projects.** These projects are filed under state agencies. When you report a county figure, say it excludes them.
- **IA designation does not guarantee housing records.** `ia_declared` combines legacy `iaProgramDeclared` and `ihProgramDeclared` (IHP), including older IA-only declarations. Search rollups cover the whole declaration unless `area_totals_unavailable`; detail and resource flags cover fetched rows, so a false flag with partial coverage cannot establish absence. For a county's designation, read `designated_areas` in `fema_get_disaster` or county-filtered search's `matched_areas`. Housing datasets have their own coverage and recent data can lag.
- **Use `fema_get_disaster` for headline funding.** Its `funding` block gives IHP approvals, PA obligations, and HMGP obligations. IHP includes housing and other needs. PA can include categories outside A–B and C–G. Cite the relevant load date and retain nulls. For a county or applicant breakdown, aggregate the project or housing table for that filter. Check each table’s staged count and truncation first. If staging is unavailable, follow `next_offset` through the last page.
- **NFIP claims carry no disaster number.** Scope `fema_search_nfip` by state, county FIPS, and loss year. For a named event, pass the exact stored spelling in `flood_event`, such as `Hurricane Harvey`. To discover spellings, remove the event filter and inspect the year-range results. On a staged match, `GROUP BY flood_event` shows the names present on that table, including a NULL group for unnamed losses.
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

**Money for a disaster.** Find the disaster number. For headline figures, use `fema_get_disaster`. For a county, filter the assistance tools with its recognized name and type (such as `Harris County`). Check the returned county names. Group PA projects by applicant ID and name, or housing assistance by ZIP. Aggregate each table to the intended geography before joining to avoid multiplying amounts across projects or housing records. Report which PA amount you summed; the tool's field descriptions define each one.

**Flood claims for an area.** Get the 5-digit FIPS from the declaration tools. Call `fema_search_nfip` with state, county, and year range at offset 0, then aggregate on the canvas. Add `flood_event` to restrict the same workflow to a named catastrophe.

**A dataset the curated tools don't cover.** List candidates from `DataSets` with `substringof` on `name`, read the dataset's fields from `DataSetFields`, read one row, then filter.

At offset 0, PA and housing can stage a match larger than the returned page. NFIP stages when the match exceeds its character budget. Pass the returned `canvas_id` to `fema_dataframe_describe` for table and column names, then to `fema_dataframe_query` for SQL. Reuse it on later staging calls to keep related tables together. If it expires, repeat the source calls to rebuild the canvas.
