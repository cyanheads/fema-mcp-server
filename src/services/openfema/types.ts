/**
 * @fileoverview Domain types for the OpenFEMA service layer.
 * @module services/openfema/types
 */

/** Raw OpenFEMA response envelope (metadata at root, not nested). */
export interface OpenFemaEnvelope {
  /** Total matching count — only populated when $inlinecount=allpages was sent. */
  count: number;
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
  /** The entity data array — key matches entityname. */
  [entityName: string]: unknown;
}

/** OpenFEMA 400 error response shape. */
export interface OpenFemaErrorResponse {
  error: Array<{
    name: string;
    code: string;
    type: string;
    message: string;
  }>;
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
  incidentBeginDate?: string;
  incidentEndDate?: string;
  incidentType?: string;
  lastRefresh?: string;
  paProgramDeclared?: boolean;
  placeCode?: string;
  state?: string;
  stateName?: string;
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
  pwNumber?: string;
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

/** An NFIP claims row. */
export interface RawNfipClaim {
  amountPaidOnBuildingClaim?: number;
  amountPaidOnContentsClaim?: number;
  buildingDamageAmount?: number;
  causeOfDamage?: string;
  contentsDamageAmount?: number;
  countyCode?: string;
  dateOfLoss?: string;
  hash?: string;
  id?: string;
  lastRefresh?: string;
  occupancyType?: string;
  ratedFloodZone?: string;
  reportedZipCode?: string;
  state?: string;
  yearOfLoss?: number;
}
