import { describe, expect, it } from 'vitest'
import tokensCss from './tokens.css?inline'

/** Selectors whose block sets `flex: 0 1 16rem`. Comments are ignored. */
function selectorsWithFieldBasis(css: string): string[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors: string[] = []
  for (const match of source.matchAll(/([^{}@][^{]*)\{([^{}]*)\}/g)) {
    const body = match[2] ?? ''
    if (!/(?:^|;)\s*flex\s*:\s*0\s+1\s+16rem\s*(?:!important\s*)?(?:;|$)/.test(body)) continue
    selectors.push((match[1] ?? '').replace(/\s+/g, ' ').trim())
  }
  return selectors
}

function parts(selector: string): string[] {
  return selector.split(',').map((part) => part.trim()).filter(Boolean)
}

describe('sample field flex', () => {
  it('keeps flex 0 1 16rem on .sd-preview .sd-field and not on .sd-field', () => {
    const owned = selectorsWithFieldBasis(tokensCss).flatMap(parts)
    expect(owned).toEqual(['.sd-preview .sd-field'])
  })
})
