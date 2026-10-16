/**
 * @fileoverview Tests for the case-insensitive name matcher — the exact-case spellings it
 * resolves from the bundled OpenFEMA vocabulary, the fixed fallback variants, the OData
 * clause it builds, the worst case over every input, and scan time on caller-sized input.
 * @module tests/services/name-matcher.test
 */

import { describe, expect, it } from 'vitest';
import {
  anySubstringFilter,
  countySpellings,
  incidentTypeSpellings,
} from '@/services/openfema/name-matcher.js';
import {
  DESIGNATED_AREAS,
  INCIDENT_TYPES,
  VOCABULARY_AS_OF,
} from '@/services/openfema/name-vocabulary.js';

describe('countySpellings', () => {
  it.each([
    ['harris', ['Harris', 'harris', 'HARRIS']],
    ['HARRIS', ['Harris', 'HARRIS', 'harris']],
    ['dekalb', ['DeKalb', 'dekalb', 'DEKALB', 'Dekalb']],
    ['mclean', ['McLean', 'mclean', 'MCLEAN', 'Mclean']],
    ['miami-dade', ['Miami-Dade', 'miami-dade', 'MIAMI-DADE']],
    [
      'st. john the baptist',
      ['St. John the Baptist', 'st. john the baptist', 'ST. JOHN THE BAPTIST'],
    ],
    ["o'brien", ["O'Brien", "o'brien", "O'BRIEN"]],
  ])('resolves %j to the stored spellings first, then the fixed variants', (input, expected) => {
    expect(countySpellings(input)).toEqual(expected);
  });

  it('sends only the fixed variants for a name the snapshot lacks', () => {
    expect(countySpellings('zzqx')).toEqual(['zzqx', 'ZZQX', 'Zzqx']);
    expect(countySpellings('new-name o’ville')).toEqual([
      'new-name o’ville',
      'NEW-NAME O’VILLE',
      'New-Name O’ville',
    ]);
  });

  it('keeps a mixed-case input as given, so a name newer than the snapshot still matches in the casing the caller typed', () => {
    for (const input of ['LaZqxville', 'McZqx']) {
      expect(countySpellings(input)).toContain(input);
      expect(incidentTypeSpellings(input)).toContain(input);
    }
  });

  /**
   * PA's `county` stores `DeKalb County`, `St. John the Baptist Parish`, and `St. Louis, City of`
   * where `designatedArea` stores `DeKalb (County)`, `St. John the Baptist (Parish)`, and
   * `St. Louis`. The `<name> <type>` forms resolve from the snapshot and lead the list; the
   * `, City of` and `, Municipality of` forms, and `Valdez–Cordova` with the en dash PA stores
   * (`designatedArea` has a hyphen), have no snapshot form and are reached by the Title Case variant.
   */
  it.each([
    ['dekalb county', ['DeKalb County', 'dekalb county', 'DEKALB COUNTY', 'Dekalb County']],
    ['MCLEAN COUNTY', ['McLean County', 'MCLEAN COUNTY', 'mclean county', 'Mclean County']],
    ['dewitt county', ['DeWitt County', 'dewitt county', 'DEWITT COUNTY', 'Dewitt County']],
    [
      'yukon-koyukuk census area',
      ['Yukon-Koyukuk Census Area', 'yukon-koyukuk census area', 'YUKON-KOYUKUK CENSUS AREA'],
    ],
    [
      'st. john the baptist parish',
      ['St. John the Baptist Parish', 'st. john the baptist parish', 'ST. JOHN THE BAPTIST PARISH'],
    ],
    ['st. louis, city of', ['st. louis, city of', 'ST. LOUIS, CITY OF', 'St. Louis, City of']],
    [
      'anchorage, municipality of',
      ['anchorage, municipality of', 'ANCHORAGE, MUNICIPALITY OF', 'Anchorage, Municipality of'],
    ],
    [
      'valdez–cordova census area',
      ['valdez–cordova census area', 'VALDEZ–CORDOVA CENSUS AREA', 'Valdez–Cordova Census Area'],
    ],
  ])('resolves the PA county form %j to %j', (input, expected) => {
    expect(countySpellings(input)).toEqual(expected);
  });

  it('keeps of, the, and and lowercase after the first word of the Title Case variant', () => {
    expect(countySpellings('of zqx the zqy and zqz').at(-1)).toBe('Of Zqx the Zqy and Zqz');
  });

  it('title-cases after a space, hyphen, en dash, apostrophe, period, slash, and parenthesis', () => {
    expect(countySpellings("zq-zq zq–zq zq'zq zq.zq zq/zq (zq)").at(-1)).toBe(
      "Zq-Zq Zq–Zq Zq'Zq Zq.Zq Zq/Zq (Zq)",
    );
  });

  it('trims the input and treats a blank as no filter', () => {
    expect(countySpellings('  Harris \t')).toEqual(countySpellings('Harris'));
    for (const blank of ['', ' ', '\t\n']) expect(countySpellings(blank)).toEqual([]);
  });
});

describe('incidentTypeSpellings', () => {
  it.each([
    ['hurricane', ['Hurricane', 'hurricane', 'HURRICANE']],
    ['HURRICANE', ['Hurricane', 'HURRICANE', 'hurricane']],
    ['storm', ['Storm', 'storm', 'STORM']],
    ['severe storm', ['Severe Storm', 'severe storm', 'SEVERE STORM']],
  ])('resolves %j to %j', (input, expected) => {
    expect(incidentTypeSpellings(input)).toEqual(expected);
  });

  it('storm reaches every stored type containing it in any case, Snowstorm included', () => {
    const spellings = incidentTypeSpellings('storm');
    const matched = INCIDENT_TYPES.filter((type) => spellings.some((s) => type.includes(s)));
    expect(matched).toEqual(INCIDENT_TYPES.filter((type) => /storm/i.test(type)));
    expect(matched).toContain('Snowstorm');
    expect(matched).toContain('Severe Storm');
  });

  it('treats a blank as no filter', () => {
    expect(incidentTypeSpellings('   ')).toEqual([]);
  });
});

describe('anySubstringFilter', () => {
  it('sends one spelling as a bare substringof', () => {
    expect(anySubstringFilter('county', ['Harris'])).toBe("substringof('Harris', county)");
  });

  it('or-joins several in parentheses and escapes single quotes', () => {
    expect(anySubstringFilter('designatedArea', countySpellings("o'brien"))).toBe(
      "(substringof('O''Brien', designatedArea) or substringof('o''brien', designatedArea) or substringof('O''BRIEN', designatedArea))",
    );
  });
});

describe('name vocabulary snapshot', () => {
  it('records the date it was read', () => {
    expect(VOCABULARY_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each([
    ['DESIGNATED_AREAS', DESIGNATED_AREAS],
    ['INCIDENT_TYPES', INCIDENT_TYPES],
  ])('%s is sorted, distinct, non-blank, and keeps its length when lowercased', (_, values) => {
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(values);
    for (const value of values) {
      expect(value.trim()).not.toBe('');
      expect(value.toLowerCase()).toHaveLength(value.length);
    }
  });
});

/**
 * The most distinct exact-case forms any input can resolve to in a vocabulary: every
 * substring of every stored value, grouped by its lowercase form.
 */
function mostStoredForms(vocabulary: readonly string[]): number {
  const forms = new Map<string, Set<string>>();
  for (const value of vocabulary) {
    for (let start = 0; start < value.length; start++) {
      for (let end = start + 1; end <= value.length; end++) {
        const form = value.slice(start, end);
        const key = form.toLowerCase();
        const seen = forms.get(key) ?? new Set<string>();
        seen.add(form);
        forms.set(key, seen);
      }
    }
  }
  let most = 0;
  for (const seen of forms.values()) most = Math.max(most, seen.size);
  return most;
}

/** Every 1- and 2-character input over the characters the vocabulary holds. */
function shortInputs(vocabulary: readonly string[]): string[] {
  const chars = [...new Set(vocabulary.join('').toLowerCase())];
  return [...chars, ...chars.flatMap((a) => chars.map((b) => `${a}${b}`))];
}

describe('worst case over every input', () => {
  /**
   * Any input resolves to at most the stored forms of one lowercase string plus four fixed
   * variants (as given, lower, UPPER, Title): with these snapshot maxima, at most 8 county and
   * 6 incident-type spellings.
   */
  it('the snapshot holds at most 4 stored forms of any county substring and 2 of any incident-type substring', () => {
    expect(mostStoredForms(DESIGNATED_AREAS)).toBe(4); // "ap": ap, Ap, aP, AP
    expect(mostStoredForms(INCIDENT_TYPES)).toBe(2); // "b": B, b
  });

  it('1- and 2-character inputs, the most ambiguous, resolve to at most 4 spellings', () => {
    const most = (spell: (input: string) => string[], inputs: string[]) =>
      Math.max(
        ...inputs.flatMap((input) => [input, input.toUpperCase()]).map((i) => spell(i).length),
      );
    expect(most(countySpellings, shortInputs(DESIGNATED_AREAS))).toBe(4);
    expect(most(incidentTypeSpellings, shortInputs(INCIDENT_TYPES))).toBe(3);
  });
});

/** Thread CPU milliseconds for `fn`, the least of three runs. */
function cpuMs(fn: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run++) {
    const start = process.threadCpuUsage();
    fn();
    const used = process.threadCpuUsage(start);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}

describe('scan time on caller-sized input', () => {
  it.each([
    ['a digit run', (n: number) => '1'.repeat(n), 320_000],
    ['separators before every letter', (n: number) => 'a-'.repeat(n / 2), 80_000],
  ])('grows linearly on %s', (_, make, largest) => {
    const smallest = largest / 64;
    const small = cpuMs(() => countySpellings(make(smallest)));
    const large = cpuMs(() => countySpellings(make(largest)));
    expect(large / Math.max(small, 0.05)).toBeLessThan(256);
    expect(large).toBeLessThan(500);
  });
});
