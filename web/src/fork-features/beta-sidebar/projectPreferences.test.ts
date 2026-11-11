import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readProjectPreferences, useProjectPreferences } from './projectPreferences'

beforeEach(() => {
    localStorage.removeItem('hapi.beta.projects.v1:test-hub|alice')
    localStorage.removeItem('hapi.beta.projects.v1:test-hub|bob')
    localStorage.removeItem('hapi.beta.projects.v1:other-hub|alice')
})
afterEach(() => {
    cleanup()
    localStorage.removeItem('hapi.beta.projects.v1:test-hub|alice')
    localStorage.removeItem('hapi.beta.projects.v1:test-hub|bob')
    localStorage.removeItem('hapi.beta.projects.v1:other-hub|alice')
})

describe('account and Hub scoped project preferences', () => {
    it('defaults to project aggregation and validates malformed persisted values', () => {
        expect(readProjectPreferences('test-hub|alice')).toMatchObject({ mode: 'projects', collapseAll: false, favorites: {} })
        localStorage.setItem('hapi.beta.projects.v1:test-hub|alice', '{')
        expect(readProjectPreferences('test-hub|alice').mode).toBe('projects')
        localStorage.setItem('hapi.beta.projects.v1:test-hub|alice', JSON.stringify({ mode: 'invalid', favorites: { valid: true, invalid: 'true' }, collapsed: { explicit: false }, aliases: { valid: '本地别名', invalid: 1 } }))
        expect(readProjectPreferences('test-hub|alice')).toMatchObject({ mode: 'projects', favorites: { valid: true }, collapsed: { explicit: false }, aliases: { valid: '本地别名' } })
    })

    it('retains explicit folds, favorites, aliases and mode on reload without leaking to another account or Hub', () => {
        const { result, rerender } = renderHook(({ scope }) => useProjectPreferences(scope), { initialProps: { scope: 'test-hub|alice' } })
        act(() => result.current[1](current => ({ ...current, mode: 'favorites', collapseAll: true, collapsed: { project: true }, favorites: { project: true }, aliases: { project: 'My project' } })))
        expect(readProjectPreferences('test-hub|alice')).toMatchObject({ mode: 'favorites', collapseAll: true, collapsed: { project: true }, favorites: { project: true }, aliases: { project: 'My project' } })
        rerender({ scope: 'test-hub|bob' })
        expect(result.current[0]).toMatchObject({ mode: 'projects', favorites: {}, collapsed: {}, aliases: {} })
        act(() => result.current[1](current => ({ ...current, mode: 'directories' })))
        rerender({ scope: 'other-hub|alice' })
        expect(result.current[0].mode).toBe('projects')
        rerender({ scope: 'test-hub|alice' })
        expect(result.current[0]).toMatchObject({ mode: 'favorites', collapseAll: true, aliases: { project: 'My project' } })
        expect(readProjectPreferences('test-hub|bob').mode).toBe('directories')
    })

    it('does not persist into a shared anonymous key when identity is unavailable', () => {
        const { result } = renderHook(() => useProjectPreferences())
        const existingKeys = Object.keys(localStorage).sort()
        act(() => result.current[1](current => ({ ...current, collapseAll: true, favorites: { project: true } })))
        expect(result.current[0].collapseAll).toBe(true)
        expect(Object.keys(localStorage).sort()).toEqual(existingKeys)
        expect(readProjectPreferences().favorites).toEqual({})
    })
})
