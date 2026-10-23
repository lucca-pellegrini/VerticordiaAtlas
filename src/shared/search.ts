// search.ts: text matching for the homepage and the map search. Words are compared by Levenshtein distance, so
// a typo costs one edit (two for words of more than four letters). Used by home and app; sw.js precaches it.

// lower case, no accents: "Élan" -> "elan"
export const norm = (s: unknown): string =>
  String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

// the text with every run of non-letters and non-digits as one space: "Armorer's Cookbook" -> "armorer s cookbook"
export const flat = (s: unknown): string =>
  norm(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// the words of a text, three letters or more: shorter ones are too common to tell apart by a typo
export const words = (s: unknown): string[] =>
  flat(s).split(' ').filter(w => w.length >= 3);

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Total edit distance of the query's words against the text's words, or null when a query word is too far off or no
// query word is long enough to compare. Query words under three letters are skipped here: they are matched exactly by
// the callers, so "tower of returm" still finds "Tower of Return".
export function fuzzyScore(queryWords: string[], textWords: string[]): number | null {
  let total = 0, counted = 0;
  for (const qw of queryWords) {
    if (qw.length < 3) continue;
    const allowed = qw.length <= 4 ? 1 : 2;
    let best = Infinity;
    for (const tw of textWords) best = Math.min(best, levenshtein(qw, tw));
    if (best > allowed) return null;
    total += best;
    counted++;
  }
  return counted ? total : null;
}
