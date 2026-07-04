/**
 * @fileoverview Shared set of valid US state/territory codes accepted by OpenFEMA.
 * @module services/openfema/us-states
 */

/**
 * Valid US state/territory abbreviations accepted by OpenFEMA.
 *
 * Single source of truth for state-code validation across the state-scoped FEMA
 * tools (fema_search_disasters, fema_get_public_assistance, fema_get_housing_assistance,
 * fema_search_nfip). Covers the 50 states, DC, the five inhabited territories, and the
 * three Compact-of-Free-Association nations (FM, MH, PW) that OpenFEMA still lists.
 */
export const US_STATES = new Set([
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'DC',
  'PR',
  'VI',
  'GU',
  'AS',
  'MP',
  'FM',
  'MH',
  'PW',
]);
