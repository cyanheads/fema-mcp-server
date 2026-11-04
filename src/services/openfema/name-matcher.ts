/**
 * @fileoverview Case-insensitive name matching for OpenFEMA's case-sensitive `substringof`.
 * OpenFEMA has no case-folding filter function, so a caller's name is resolved to the
 * exact-case substrings that occur in the stored values (a bundled snapshot), plus fixed
 * lower/UPPER/Title variants for values stored after the snapshot was read. Sending each as
 * an `or`-joined `substringof` keeps substring semantics with no extra request.
 * @module services/openfema/name-matcher
 */

import { DESIGNATED_AREAS, INCIDENT_TYPES, PA_COUNTIES } from './name-vocabulary.js';
import { escapeODataString } from './openfema-service.js';

/**
 * Each stored value beside its lowercased form. The generator verifies that lowercasing
 * preserves lengths, so match positions in the lowered form also index the stored value.
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
  ...new Set([
    ...PA_COUNTIES,
    ...DESIGNATED_AREAS.flatMap((area) => {
      const typed = AREA_TYPE.exec(area);
      return typed ? [area, `${typed[1]} ${typed[2]}`] : [area];
    }),
  ]),
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

/** Stored spellings only, for a nonblank trimmed input; synthetic aliases need no fallback. */
function storedSpellingsIn(input: string, vocabulary: IndexedVocabulary): string[] {
  const lower = input.toLowerCase();
  const found = new Set<string>();
  for (const [value, lowered] of vocabulary) {
    for (let at = lowered.indexOf(lower); at !== -1; at = lowered.indexOf(lower, at + 1)) {
      found.add(value.slice(at, at + lower.length));
    }
  }
  return [...found].sort();
}

/** Stored spellings followed by fixed case fallbacks, retaining names added after the snapshot. */
function spellingsIn(input: string, vocabulary: IndexedVocabulary): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  return [
    ...new Set([
      ...storedSpellingsIn(trimmed, vocabulary),
      trimmed,
      lower,
      trimmed.toUpperCase(),
      titleCase(lower),
    ]),
  ];
}

/**
 * Exact-case spellings of a county or other designated-area name, resolved against the
 * declaration `designatedArea` values, their `<name> <type>` forms, and PA `county` values.
 * Recognized terminal area types accept either parentheses form, without broadening to a
 * bare name. Unknown counterparts add no synthetic aliases, preserving existing fallbacks
 * and avoiding URL growth for long names that cannot occur in the snapshot.
 * Exact PA spellings are included even where declaration names differ beyond casing.
 */
export function countySpellings(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  const original = spellingsIn(trimmed, AREA_VOCABULARY);
  const lower = trimmed.toLowerCase();
  for (const type of ['county', 'parish', 'borough', 'census area']) {
    const parenthesized = ` (${type})`;
    const plain = ` ${type}`;
    if (lower.endsWith(parenthesized) && trimmed.length > parenthesized.length) {
      const name = trimmed.slice(0, -parenthesized.length);
      const storedType = trimmed.slice(-parenthesized.length + 2, -1);
      return [
        ...new Set([...original, ...storedSpellingsIn(`${name} ${storedType}`, AREA_VOCABULARY)]),
      ];
    }
    if (lower.endsWith(plain) && trimmed.length > plain.length) {
      const name = trimmed.slice(0, -plain.length);
      const storedType = trimmed.slice(-type.length);
      return [
        ...new Set([...original, ...storedSpellingsIn(`${name} (${storedType})`, AREA_VOCABULARY)]),
      ];
    }
  }
  return original;
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
