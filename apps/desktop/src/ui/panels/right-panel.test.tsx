import { describe, expect, it } from 'vitest'
import { RIGHT_PANEL_TABS } from '../../services/layout/layout'
import { TAB_CHROME } from './right-panel'

describe('right panel tabs', () => {
  it('derives chrome keys from RIGHT_PANEL_TABS', () => {
    expect(Object.keys(TAB_CHROME).sort()).toEqual([...RIGHT_PANEL_TABS].sort())
  })
})
