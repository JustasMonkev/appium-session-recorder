import { createSignal, onCleanup, createEffect } from 'solid-js';
import type { Interaction } from '../types';
import { connectToStream, fetchInteraction, type StreamEvent } from '../services/api';

export function applyStreamEvent(interactions: Interaction[], event: StreamEvent): Interaction[] {
    if (event.type === 'init') return event.data;
    if (event.type === 'clear') return [];
    if (event.type === 'evict') {
        const evicted = new Set(event.data.ids);
        return interactions.filter(interaction => !evicted.has(interaction.id));
    }

    const existing = interactions.findIndex(interaction => interaction.id === event.data.id);
    if (existing < 0) return [...interactions, event.data];
    const updated = [...interactions];
    updated[existing] = event.data;
    return updated;
}

export function applyHydratedInteraction(
    interactions: Interaction[],
    summary: Interaction,
    details: Interaction,
): Interaction[] {
    const index = interactions.indexOf(summary);
    if (index < 0) return interactions;
    const hydrated = [...interactions];
    hydrated[index] = details;
    return hydrated;
}

export function useInteractions() {
    const [interactions, setInteractions] = createSignal<Interaction[]>([]);

    createEffect(() => {
        const unsubscribe = connectToStream((event) => {
            setInteractions(interactions => applyStreamEvent(interactions, event));
        });

        onCleanup(unsubscribe);
    });

    const hydrateInteraction = async (summary: Interaction, signal: AbortSignal): Promise<boolean> => {
        if (!summary.detailsTruncated || !summary.detailsUrl) return false;
        const details = await fetchInteraction(summary.detailsUrl, signal);
        let applied = false;
        setInteractions(current => {
            const hydrated = applyHydratedInteraction(current, summary, details);
            applied = hydrated !== current;
            return hydrated;
        });
        return applied;
    };

    return { interactions, hydrateInteraction };
}
