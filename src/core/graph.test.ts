import { describe, it, expect } from 'vitest'
import { walkGraph, makeId, type ArtifactRef, type ResolverRegistry } from './graph'

function ref(table: string, sysId: string, depth = 0): ArtifactRef {
  return { id: makeId(table, sysId), table, sysId, type: 'script_include', label: sysId, relation: '', depth, fields: {} }
}

describe('walkGraph', () => {
  it('respects the depth limit', async () => {
    // Chain: root → a → b → c ; each SI references the next.
    const chain: Record<string, string> = { root: 'a', a: 'b', b: 'c', c: '' }
    const resolvers: ResolverRegistry = {
      script_include: (art) => {
        const next = chain[art.sysId]
        return next ? [{ table: 'sys_script_include', query: `name=${next}`, type: 'script_include', relation: 'ref' }] : []
      },
    }
    const fetchPage = async (spec: { query: string }, depth: number) => {
      const name = spec.query.split('=')[1]
      return [{ ...ref('sys_script_include', name, depth) }]
    }

    const root = ref('sys_script_include', 'root')
    const result = await walkGraph(root, resolvers, { maxDepth: 2, fetchPage })
    const ids = result.map((r) => r.sysId)
    // root (depth0) → a (depth1) → b (depth2). c is beyond the limit.
    expect(ids).toEqual(['root', 'a', 'b'])
  })

  it('dedupes artifacts discovered via multiple paths', async () => {
    const resolvers: ResolverRegistry = {
      script_include: (art) =>
        art.sysId === 'root'
          ? [
              { table: 't', query: 'name=shared', type: 'script_include', relation: 'r' },
              { table: 't', query: 'name=shared', type: 'script_include', relation: 'r' },
            ]
          : [],
    }
    const fetchPage = async (spec: { query: string }, depth: number) => [
      ref('t', spec.query.split('=')[1], depth),
    ]
    const result = await walkGraph(ref('sys_script_include', 'root'), resolvers, { maxDepth: 2, fetchPage })
    expect(result.filter((r) => r.sysId === 'shared')).toHaveLength(1)
  })

  it('stops early when the frontier empties', async () => {
    const resolvers: ResolverRegistry = { script_include: () => [] }
    const result = await walkGraph(ref('x', 'only'), resolvers, {
      maxDepth: 5,
      fetchPage: async () => [],
    })
    expect(result).toHaveLength(1)
  })
})
