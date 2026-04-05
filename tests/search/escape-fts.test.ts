import { describe, expect, it } from 'bun:test';

/**
 * Tests for FTS5 query escaping.
 * Inlined to avoid importing search.ts which has DB dependencies.
 */

function escapeFtsQuery(query: string): string {
  const cleaned = query.replace(/[^\w\s*]/g, ' ');
  const words = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const base = word.replace(/\*/g, '');
      if (!base) return null;
      return word.includes('*') ? `"${base}"*` : `"${base}"`;
    })
    .filter(Boolean);
  if (words.length === 0) return '';
  return words.join(' OR ');
}

describe('escapeFtsQuery', () => {
  it('wraps words in double quotes', () => {
    expect(escapeFtsQuery('hello world')).toBe('"hello" OR "world"');
  });

  it('handles prefix queries', () => {
    expect(escapeFtsQuery('arch*')).toBe('"arch"*');
  });

  it('strips special characters', () => {
    expect(escapeFtsQuery('hello-world')).toBe('"hello" OR "world"');
  });

  it('returns empty for empty input', () => {
    expect(escapeFtsQuery('')).toBe('');
    expect(escapeFtsQuery('   ')).toBe('');
  });

  it('returns empty for only special chars', () => {
    expect(escapeFtsQuery('***')).toBe('');
    expect(escapeFtsQuery('---')).toBe('');
  });

  it('handles mixed prefix and normal', () => {
    expect(escapeFtsQuery('api over*')).toBe('"api" OR "over"*');
  });

  it('handles single word', () => {
    expect(escapeFtsQuery('architecture')).toBe('"architecture"');
  });
});
