/**
 * @fileoverview Case-insensitive name matching for OpenFEMA's case-sensitive `substringof`.
 * OpenFEMA has no case-folding filter function, so a caller's name is resolved to the
 * exact-case substrings that occur in the stored values (a bundled snapshot), plus fixed
 * lower/UPPER/Title variants for values stored after the snapshot was read. Sending each as
 * an `or`-joined `substringof` keeps substring semantics with no extra request.
 * @module services/openfema/name-matcher
 */

import { DESIGNATED_AREAS, INCIDENT_TYPES } from './name-vocabulary.js';
import { escapeODataString } from './openfema-service.js';

/**
 * Each stored value beside its lowercased form. The snapshot is ASCII, so lowercasing keeps
 * every value's length and a match position in the lowered form is the same in the value.
 */
type IndexedVocabulary = readonly (readonly [value: string, lowered: string])[];

const index = (values: readonly string[]): IndexedVocabulary =>
  values.map((value) => [value, value.toLowerCase()] as const);

/**
 * `designatedArea` stores a county as `DeKalb (County)`; PA's `county` stores the same area as
 * `DeKalb County`. Indexing both forms lets a caller typing the PA form in any case resolve
 * to its stored casing.
 */
const AREA_TYPE = /^(.+) \((County|Parish|Borough|Census Area)\)$/;

const AREA_VOCABULARY = index([
  ...new Set(
    DESIGNATED_AREAS.flatMap((area) => {
      const typed = AREA_TYPE.exec(area);
      return typed ? [area, `${typed[1]} ${typed[2]}`] : [area];
    }),
  ),
]);
const INCIDENT_TYPE_VOCABULARY = index(INCIDENT_TYPES);

/**
 * Title Case: a letter opening the value or following a space, hyphen, en dash, apostrophe,
 * period, slash, or parenthesis — except `of`, `the`, and `and` after the first word, which
 * OpenFEMA stores lowercase (`St. Louis, City of`, `St. John the Baptist`).
 */
function titleCase(lower: string): string {
  return lower
    .replace(
      /(^|[\s\-–'./(])(\p{Ll})/gu,
      (_, before: string, letter: string) => `${before}${letter.toUpperCase()}`,
    )
    .replace(/(?<=\s)(?:Of|The|And)(?=\s|$)/g, (word) => word.toLowerCase());
}

/**
 * The exact-case substrings to send for `input`: every distinct spelling of it found in
 * `vocabulary`, then the input as given, lowercase, UPPERCASE, and Title Case. A blank
 * input yields none.
 */
function spellingsIn(input: string, vocabulary: IndexedVocabulary): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  const found = new Set<string>();
  for (const [value, lowered] of vocabulary) {
    for (let at = lowered.indexOf(lower); at !== -1; at = lowered.indexOf(lower, at + 1)) {
      found.add(value.slice(at, at + lower.length));
    }
  }
  return [
    ...new Set([...[...found].sort(), trimmed, lower, trimmed.toUpperCase(), titleCase(lower)]),
  ];
}

/**
 * Exact-case spellings of a county or other designated-area name, resolved against the
 * `designatedArea` values of DisasterDeclarationsSummaries and their `<name> <type>` forms.
 * Name casing is shared across OpenFEMA datasets, so the result also serves county fields
 * stored in other forms (`Harris County`, `Harris (County)`).
 */
export function countySpellings(input: string): string[] {
  return spellingsIn(input, AREA_VOCABULARY);
}

/** Exact-case spellings of an incident type fragment, resolved against OpenFEMA's incident types. */
export function incidentTypeSpellings(input: string): string[] {
  return spellingsIn(input, INCIDENT_TYPE_VOCABULARY);
}

/**
 * An OData clause matching `field` against any of `spellings` (non-empty) — a single
 * `substringof`, or several `or`-joined in parentheses so the clause composes with `and`.
 */
export function anySubstringFilter(field: string, spellings: readonly string[]): string {
  const clauses = spellings
    .map((spelling) => `substringof('${escapeODataString(spelling)}', ${field})`)
    .join(' or ');
  return spellings.length === 1 ? clauses : `(${clauses})`;
}
