import { describe, expect, it } from 'vitest';
import { applyHydratedInteraction, applyStreamEvent } from '../useInteractions';
import type { Interaction } from '../../types';

function interaction(id: number, path = `/action/${id}`): Interaction {
    return {
        id,
        timestamp: '2026-01-01T00:00:00.000Z',
        method: 'POST',
        path,
    };
}

describe('applyStreamEvent', () => {
    it('initializes, appends, and updates interactions without changing order', () => {
        const initial = [interaction(1), interaction(2)];
        const initialized = applyStreamEvent([], { type: 'init', data: initial });
        const appended = applyStreamEvent(initialized, {
            type: 'interaction',
            data: interaction(3),
        });
        const updated = applyStreamEvent(appended, {
            type: 'interaction',
            data: interaction(2, '/updated'),
        });

        expect(updated.map(item => item.id)).toEqual([1, 2, 3]);
        expect(updated[1].path).toBe('/updated');
        expect(initial[1].path).toBe('/action/2');
    });

    it('evicts every listed id and ignores unknown ids', () => {
        const current = [interaction(1), interaction(2), interaction(3)];

        expect(applyStreamEvent(current, {
            type: 'evict',
            data: { ids: [1, 3, 999] },
        }).map(item => item.id)).toEqual([2]);
    });

    it('clears all interactions', () => {
        expect(applyStreamEvent([interaction(1)], { type: 'clear', data: null })).toEqual([]);
    });

    it('does not let stale detail hydration overwrite a newer stream update', () => {
        const summary = { ...interaction(1), detailsUrl: '/_recorder/api/interaction/1', detailsTruncated: true };
        const newer = interaction(1, '/newer');
        const newerSummary = { ...summary, path: '/newer-summary' };
        const staleDetails = interaction(1, '/stale-details');

        expect(applyHydratedInteraction([newer], summary, staleDetails)).toEqual([newer]);
        expect(applyHydratedInteraction([newerSummary], summary, staleDetails)).toEqual([newerSummary]);
        expect(applyHydratedInteraction([summary], summary, staleDetails)).toEqual([staleDetails]);
    });
});
