import { describe, expect, it } from 'vitest';
import { adjacentId, reconcileSelection } from './command-region-selection';

describe('identity-based command selection', () => {
    const entries = [{ id: 'a', completed: true }, { id: 'b', completed: true }];
    it('does not wrap and uses explicit ids', () => {
        expect(adjacentId(['a', 'b'], 'a', 'previous')).toBe(null);
        expect(adjacentId(['a', 'b'], 'b', 'next')).toBe(null);
        expect(adjacentId(['a', 'b'], 'a', 'next')).toBe('b');
        expect(adjacentId([], null, 'next')).toBe(null);
        expect(adjacentId(['a'], 'missing', 'next')).toBe(null);
    });
    it('initially prefers latest completed; keeps it while next is running', () => {
        expect(reconcileSelection({ selectedCommandId: null, followingLatest: true }, entries).selectedCommandId).toBe('b');
        expect(reconcileSelection({ selectedCommandId: 'b', followingLatest: true }, [...entries, { id: 'c', completed: false }]).selectedCommandId).toBe('b');
    });
    it('follows new completion but does not steal an older explicit selection', () => {
        expect(reconcileSelection({ selectedCommandId: 'a', followingLatest: true }, entries).selectedCommandId).toBe('b');
        expect(reconcileSelection({ selectedCommandId: 'a', followingLatest: false }, entries).selectedCommandId).toBe('a');
    });
    it('recovers disposed selection and clears empty panes', () => {
        expect(reconcileSelection({ selectedCommandId: 'gone', followingLatest: false }, entries)).toEqual({ selectedCommandId: 'b', followingLatest: true });
        expect(reconcileSelection({ selectedCommandId: 'a', followingLatest: false }, [])).toEqual({ selectedCommandId: null, followingLatest: true });
    });
    it('selects a running region if no command has completed', () => {
        expect(reconcileSelection({ selectedCommandId: null, followingLatest: true }, [{ id: 'a', completed: false }]).selectedCommandId).toBe('a');
    });
    it('keeps an explicitly selected latest running region instead of jumping backward', () => {
        expect(reconcileSelection({ selectedCommandId: 'c', followingLatest: true }, [...entries, { id: 'c', completed: false }]).selectedCommandId).toBe('c');
    });
});
