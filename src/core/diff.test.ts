import { describe, it, expect } from 'vitest'
import { lineDiff, diffStats } from './diff'

describe('lineDiff', () => {
  it('marks unchanged lines as context', () => {
    const d = lineDiff('a\nb\nc', 'a\nb\nc')
    expect(d.every((l) => l.op === 'context')).toBe(true)
  })

  it('detects an added line', () => {
    const d = lineDiff('a\nc', 'a\nb\nc')
    expect(d).toContainEqual({ op: 'add', text: 'b' })
    expect(diffStats(d)).toEqual({ added: 1, removed: 0 })
  })

  it('detects a removed line', () => {
    const d = lineDiff('a\nb\nc', 'a\nc')
    expect(d).toContainEqual({ op: 'del', text: 'b' })
    expect(diffStats(d)).toEqual({ added: 0, removed: 1 })
  })

  it('detects a changed line as del + add', () => {
    const d = lineDiff('x = 1', 'x = 2')
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 })
  })
})
