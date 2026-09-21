export type RegionSelection = { selectedCommandId: string | null; followingLatest: boolean };
export type RegionEntry = { id: string; completed: boolean };

export function adjacentId(ids: readonly string[], selected: string | null, direction: 'previous' | 'next'): string | null {
    const index = selected == null ? -1 : ids.indexOf(selected);
    if (index < 0) return null;
    return ids[index + (direction === 'previous' ? -1 : 1)] ?? null;
}

export function reconcileSelection(state: RegionSelection, entries: readonly RegionEntry[]): RegionSelection {
    const latest = [...entries].reverse().find(entry => entry.completed) ?? entries[entries.length - 1];
    const exists = entries.some(entry => entry.id === state.selectedCommandId);
    if (!exists) return { selectedCommandId: latest?.id ?? null, followingLatest: true };
    if (!state.followingLatest) return state;
    if (entries[entries.length - 1]?.id === state.selectedCommandId) return state;
    return { selectedCommandId: latest?.id ?? null, followingLatest: true };
}
