import { describe, expect, it } from 'vitest'
import { BUILTIN_TERMS, glossaryForDeepgram, glossaryForPrompt, glossaryTerms } from '../src/shared/glossary'

describe('glossaryTerms', () => {
  it('puts user custom terms first, then built-ins', () => {
    const terms = glossaryTerms('Acousmos, BloxFlux')
    expect(terms[0]).toBe('Acousmos')
    expect(terms[1]).toBe('BloxFlux')
    expect(terms).toContain('Claude Code')
  })

  it('parses comma and newline separated custom terms', () => {
    const terms = glossaryTerms('Foo\nBar, Baz')
    expect(terms.slice(0, 3)).toEqual(['Foo', 'Bar', 'Baz'])
  })

  it('de-duplicates case-insensitively (custom wins position)', () => {
    const terms = glossaryTerms('anthropic')
    expect(terms[0]).toBe('anthropic')
    expect(terms.filter((t) => t.toLowerCase() === 'anthropic')).toHaveLength(1)
  })

  it('ignores blanks', () => {
    expect(glossaryTerms('  ,\n , ')).toEqual([...BUILTIN_TERMS])
  })
})

describe('glossaryForDeepgram', () => {
  it('caps the term count', () => {
    expect(glossaryForDeepgram('', 5)).toHaveLength(5)
  })
})

describe('glossaryForPrompt', () => {
  it('returns a comma-joined capped string', () => {
    const s = glossaryForPrompt('Acousmos', 3)
    expect(s.startsWith('Acousmos, ')).toBe(true)
    expect(s.split(', ')).toHaveLength(3)
  })
})
