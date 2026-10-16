/**
 * @fileoverview Domain types for the OpenFEMA service layer.
 * @module services/openfema/types
 */

/**
 * `metadata.DeprecationInformation` on a deprecated dataset version. Past `depDate` OpenFEMA
 * keeps answering the version with HTTP 200 and its old count, but no records.
 */
export interface OpenFemaDeprecationInformation {
  depApiMessage?: string | null;
  /** ISO 8601 date the version stops being served. */
  depDate?: string | null;
  /** Web page describing the replacement dataset; null when there is none. */
  depNewUrl?: string | null;
  depWebMessage?: string | null;
}

/** Metadata block nested inside the OpenFEMA response envelope. */
export interface OpenFemaMetadata {
  /** Total matching count — only populated when $inlinecount=allpages was sent. */
  count: number;
  /** Present only on a deprecated dataset version. */
  DeprecationInformation?: OpenFemaDeprecationInformation;
  entityname: string;
  filter: string;
  format: string;
  metadata: boolean;
  orderby: string;
  rundate: string;
  select: string | null;
  skip: number;
  top: number;
  url: string;
  version: string;
}

/** Raw OpenFEMA response envelope. Metadata fields are nested under `metadata`. */
export interface OpenFemaEnvelope {
  /** Metadata block — count, pagination, and request context. */
  metadata: OpenFemaMetadata;
  /** The entity data array — key matches entityname (e.g. "DisasterDeclarationsSummaries"). */
  [entityName: string]: unknown;
}

/**
 * One entry of an OpenFEMA 400 body. OData criteria errors carry `code` (`OF_OQP_*`)
 * and `type` (`$filter criteria error`, `$select criteria error`, `$orderby criteria error`);
 * raw parser errors (`{"name":"Error","message":"Fail at 0"}`) carry neither.
 */
export interface OpenFemaErrorDetail {
  code?: string;
  message?: string;
  name?: string;
  type?: string;
}

/** OpenFEMA 400 error response shape. */
export interface OpenFemaErrorResponse {
  error: OpenFemaErrorDetail[];
}

/** A row of the `OpenFemaDataSets` catalog, as selected by `name,version,webService,dataDictionary`. */
export interface OpenFemaCatalogRow {
  /** The version's data page — what a deprecated version's `depNewUrl` links to. */
  dataDictionary?: string | null;
  name?: string;
  version?: number;
  /** Full endpoint URL; its last path segment is the entity name the API serves. */
  webService?: string;
}

/** A dataset version's deprecation, as the service reports it from `DeprecationInformation`. */
export interface DatasetDeprecation {
  /** ISO 8601 date the version stops being served, when OpenFEMA gives one. */
  date?: string;
  /** OpenFEMA's API message, trimmed. */
  message?: string;
  /** Catalog name of the replacement dataset, when the catalog lists its data page. */
  replacementDataset?: string;
  /** Web page describing the replacement dataset, when OpenFEMA names one. */
  replacementUrl?: string;
}

/** One page of a dataset: its records, the total match count, and any deprecation notice. */
export interface DatasetPage<T> {
  count: number;
  deprecation?: DatasetDeprecation;
  rows: T[];
}

/** OData query options for OpenFEMA requests. */
export interface OpenFemaQueryOptions {
  filter?: string;
  inlinecount?: boolean;
  orderby?: string;
  select?: string;
  skip?: number;
  top?: number;
}

/** A disaster declaration summary row from DisasterDeclarationsSummaries. */
export interface RawDisasterDeclaration {
  closeoutDate?: string;
  declarationDate?: string;
  declarationTitle?: string;
  declarationType?: string;
  designatedArea?: string;
  disasterNumber?: number;
  fipsCountyCode?: string;
  fipsStateCode?: string;
  hash?: string;
  hmProgramDeclared?: boolean;
  iaProgramDeclared?: boolean;
  id?: string;
  ihmProgramDeclared?: boolean;
  ihProgramDeclared?: boolean;
  incidentBeginDate?: string;
  incidentEndDate?: string;
  incidentType?: string;
  lastRefresh?: string;
  paProgramDeclared?: boolean;
  placeCode?: string;
  state?: string;
}

/** A public assistance funded project row. */
export interface RawPaProject {
  applicantId?: string;
  applicationTitle?: string;
  county?: string;
  countyCode?: string;
  damageCategoryCode?: string;
  damageCategoryDescrip?: string;
  disasterNumber?: number;
  federalShareObligated?: number;
  firstObligationDate?: string;
  hash?: string;
  id?: string;
  lastObligationDate?: string;
  lastRefresh?: string;
  mitigationAmount?: number;
  projectAmount?: number;
  projectProcessStep?: string;
  projectSize?: string;
  projectStatus?: string;
  pwNumber?: number;
  stateAbbreviation?: string;
  stateNumberCode?: string;
  totalObligated?: number;
}

/** A housing assistance row for owners or renters. */
export interface RawHousingAssistance {
  approvedForFemaAssistance?: number;
  averageFemaInspectedDamage?: number;
  city?: string;
  county?: string;
  disasterNumber?: number;
  hash?: string;
  id?: string;
  lastRefresh?: string;
  noFemaInspectedDamage?: number;
  otherNeedsAmount?: number;
  rentalAmount?: number;
  repairReplaceAmount?: number;
  state?: string;
  totalApprovedIhpAmount?: number;
  totalDamage?: number;
  totalInspected?: number;
  totalInspectedWithNoDamage?: number;
  totalMaxGrants?: number;
  /** Renter-only fields */
  totalWithMajorDamage?: number;
  totalWithModerateDamage?: number;
  totalWithSubstantialDamage?: number;
  validRegistrations?: number;
  zipCode?: string;
}

/** A row of `NfipClaims` (v3) — only the fields fema_search_nfip reads. */
export interface RawNfipClaim {
  amountPaidOnBuildingClaim?: number;
  amountPaidOnContentsClaim?: number;
  buildingDamageAmount?: number;
  causeOfDamage?: string;
  contentsDamageAmount?: number;
  countyCode?: string;
  dateOfLoss?: string;
  occupancyType?: number;
  ratedFloodZone?: string;
  reportedZipCode?: string;
  state?: string;
  yearOfLoss?: number;
}
