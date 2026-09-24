/**
 * @fileoverview OpenFEMA HTTP fixtures captured from the live API (2026-09-24) and a
 * URL router for stubbing `fetch` at the service's network boundary.
 * @module tests/helpers/openfema-fixtures
 */

/** Rows from `GET /api/open/v1/OpenFemaDataSets?$select=name,version,webService`, in live order. */
export const CATALOG_ROWS = [
  /** Listed with `api: true`, but its endpoint answers every version with the HTML 404 page. */
  {
    name: 'PublicAssistanceProjectsStatus',
    version: 1,
    webService: 'https://www.fema.gov/api/open/v1/PublicAssistanceProjectsStatus',
  },
  {
    name: 'HazardMitigationGrantProgramDisasterSummaries',
    version: 2,
    webService: 'https://www.fema.gov/api/open/v2/HazardMitigationGrantProgramDisasterSummaries',
  },
  {
    name: 'FemaWebDeclarationAreas',
    version: 1,
    webService: 'https://www.fema.gov/api/open/v1/FemaWebDeclarationAreas',
  },
  /** The one entry whose catalog `name` differs from its path segment; both serve the data. */
  {
    name: 'DataSetFields',
    version: 1,
    webService: 'https://www.fema.gov/api/open/v1/OpenFemaDataSetFields',
  },
  /** The catalog's own entry, listed as `DataSets`; `OpenFemaDataSets` serves the same data. */
  { name: 'DataSets', version: 1, webService: 'https://www.fema.gov/api/open/v1/DataSets' },
  { name: 'NfipPolicies', version: 3, webService: 'https://www.fema.gov/api/open/v3/NfipPolicies' },
  {
    name: 'DisasterDeclarationsSummaries',
    version: 2,
    webService: 'https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries',
  },
  { name: 'NfipClaims', version: 3, webService: 'https://www.fema.gov/api/open/v3/NfipClaims' },
  {
    name: 'FimaNfipPolicies',
    version: 2,
    webService: 'https://www.fema.gov/api/open/v2/FimaNfipPolicies',
  },
  {
    name: 'FimaNfipClaims',
    version: 2,
    webService: 'https://www.fema.gov/api/open/v2/FimaNfipClaims',
  },
  {
    name: 'IndividualAssistanceHousingRegistrantsLargeDisasters',
    version: 1,
    webService:
      'https://www.fema.gov/api/open/v1/IndividualAssistanceHousingRegistrantsLargeDisasters',
  },
  {
    name: 'HazardMitigationGrantProgramDisasterSummaries',
    version: 3,
    webService: 'https://www.fema.gov/api/open/v3/HazardMitigationGrantProgramDisasterSummaries',
  },
  {
    name: 'HousingAssistanceOwners',
    version: 2,
    webService: 'https://www.fema.gov/api/open/v2/HousingAssistanceOwners',
  },
  {
    name: 'PublicAssistanceApplicants',
    version: 1,
    webService: 'https://www.fema.gov/api/open/v1/PublicAssistanceApplicants',
  },
  {
    name: 'PublicAssistanceFundedProjectsDetails',
    version: 2,
    webService: 'https://www.fema.gov/api/open/v2/PublicAssistanceFundedProjectsDetails',
  },
];

/** OpenFEMA JSON 400 bodies, verbatim. */
export const ERROR_BODIES = {
  selectUnknownField: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_003',
        type: '$select criteria error',
        message:
          'Criteria includes field "bogusField" not found in the data model.  Please check to ensure the fields are valid.',
      },
    ],
  },
  orderbyUnknownField: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_001',
        type: '$orderby criteria error',
        message:
          'Field "bogusField" not found in the data model.  Please check to ensure the fields are valid.',
      },
    ],
  },
  filterUnknownField: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_002',
        type: '$filter criteria error',
        message:
          'Field "bogusField" not found in the model path DisasterDeclarationsSummaries.  Please check that the fields are valid.',
      },
    ],
  },
  /** `state eq TX` — the unquoted value is read as a field name. */
  filterUnquotedString: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_002',
        type: '$filter criteria error',
        message:
          'Field "TX" not found in the model path DisasterDeclarationsSummaries.  Please check that the fields are valid.',
      },
    ],
  },
  /** `fyDeclared eq 40000` */
  filterFyDeclaredOverflow: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_002',
        type: '$filter criteria error',
        message:
          'Invalid data type of: Int32 for "DisasterDeclarationsSummaries"."fyDeclared" expected to be one of [Byte, Int16, SByte]',
      },
    ],
  },
  /** `disasterNumber eq 32768` */
  filterDisasterNumberOverflow: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_002',
        type: '$filter criteria error',
        message:
          'Invalid data type of: Int32 for "DisasterDeclarationsSummaries"."disasterNumber" expected to be one of [Byte, Int16, SByte]',
      },
    ],
  },
  /** `yearOfLoss eq 40000` against NfipClaims v3 (nullable Int16). */
  filterYearOfLossOverflow: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_002',
        type: '$filter criteria error',
        message:
          'Invalid data type of: Int32 for "NfipClaims"."yearOfLoss" expected to be one of [null, Byte, Int16, SByte]',
      },
    ],
  },
  /** `state eq 5` — a number compared with a text field. */
  filterNumberForText: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_002',
        type: '$filter criteria error',
        message:
          'Invalid data type of: SByte for "DisasterDeclarationsSummaries"."state" expected to be one of [null, Byte, String]',
      },
    ],
  },
  /** `disasterNumber eq 'abc'` — a string compared with a numeric field. */
  filterTextForNumber: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_002',
        type: '$filter criteria error',
        message:
          'Invalid data type of: String for "DisasterDeclarationsSummaries"."disasterNumber" expected to be one of [Byte, Int16, SByte]',
      },
    ],
  },
  /** `declarationDate ge 5` — a number compared with a date field. */
  filterNumberForDate: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_002',
        type: '$filter criteria error',
        message:
          'Invalid data type of: SByte for "DisasterDeclarationsSummaries"."declarationDate" expected to be one of [null, Date, DateTime, DateTimeOffset, String]',
      },
    ],
  },
  /** `state eq 300` — a number too large for Byte, compared with a text field. */
  filterLargeNumberForText: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_002',
        type: '$filter criteria error',
        message:
          'Invalid data type of: Int16 for "DisasterDeclarationsSummaries"."state" expected to be one of [null, Byte, String]',
      },
    ],
  },
  /** `iaProgramDeclared eq 1000` — a number too large for Byte, compared with a true/false field. */
  filterLargeNumberForBoolean: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_002',
        type: '$filter criteria error',
        message:
          'Invalid data type of: Int16 for "DisasterDeclarationsSummaries"."iaProgramDeclared" expected to be one of [null, Boolean, Byte]',
      },
    ],
  },
  /** `id eq 5` — a number compared with a GUID field. */
  filterNumberForGuid: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_002',
        type: '$filter criteria error',
        message:
          'Invalid data type of: SByte for "DisasterDeclarationsSummaries"."id" expected to be one of [Guid, String]',
      },
    ],
  },
  /** `fyDeclared eq 3.5` — a decimal compared with an integer field. */
  filterDecimalForInteger: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_002',
        type: '$filter criteria error',
        message:
          'Invalid data type of: Decimal for "DisasterDeclarationsSummaries"."fyDeclared" expected to be one of [Byte, Int16, SByte]',
      },
    ],
  },
  /** `declarationDate ge 'yesterday'` — a quoted value that is not a date. */
  filterInvalidDate: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_002',
        type: '$filter criteria error',
        message: 'Invalid date for "DisasterDeclarationsSummaries"."declarationDate"',
      },
    ],
  },
  /** `id eq 'nope'` — a quoted value that is not a GUID. */
  filterInvalidUuid: {
    error: [
      {
        name: 'OData Query Parser Error',
        code: 'OF_OQP_002',
        type: '$filter criteria error',
        message: 'Invalid UUID for "DisasterDeclarationsSummaries"."id"',
      },
    ],
  },
  /** `INVALID FILTER EXPRESSION` — untyped parser error. */
  untypedUnexpectedCharacter: {
    error: [{ name: 'Error', message: 'Unexpected character at 492' }],
  },
  /** `disasterNumber,,` select or `declarationDate sideways` orderby — untyped parser error. */
  untypedFailAtZero: { error: [{ name: 'Error', message: 'Fail at 0' }] },
};

/** A JSON response with the given status. */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** The Drupal "Page not found" page OpenFEMA serves for an unknown entity or version. */
export function htmlResponse(status: number): Response {
  return new Response(
    '<!DOCTYPE html>\n<html lang=en dir=ltr>\n<meta name=description content="Page not found">\n</html>',
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

/** A successful OpenFEMA envelope keyed by the entity name. */
export function envelopeResponse(
  entity: string,
  rows: unknown[],
  count = rows.length,
  version = 'v2',
): Response {
  return jsonResponse(200, { metadata: { count, entityname: entity, version }, [entity]: rows });
}

/** The live catalog response (optionally with substitute rows). */
export function catalogResponse(rows: unknown[] = CATALOG_ROWS): Response {
  return jsonResponse(200, {
    metadata: { count: rows.length, entityname: 'OpenFemaDataSets', version: 'v1' },
    OpenFemaDataSets: rows,
  });
}

/** Absolute prefix of a request for `entity` at `version` under the default API root. */
export function endpoint(entity: string, version: number): string {
  return `https://www.fema.gov/api/open/v${version}/${entity}?`;
}

/** Prefix of every catalog request. */
export const CATALOG_URL = endpoint('OpenFemaDataSets', 1);

type Responder = (url: string) => Response | Promise<Response>;

/**
 * A `fetch` implementation that answers each request from the first route whose URL
 * prefix matches, and rejects anything unrouted.
 */
export function routeFetch(routes: Array<[prefix: string, respond: Responder]>) {
  return (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    if (!route) return Promise.reject(new Error(`unrouted fetch: ${url}`));
    return Promise.resolve(route[1](url));
  };
}

/** Every URL a mocked `fetch` was called with. */
export function calledUrls(fetchMock: { mock: { calls: unknown[][] } }): string[] {
  return fetchMock.mock.calls.map(([input]) =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url,
  );
}
