import { createSignal, createMemo, onCleanup, createEffect } from 'solid-js';
import type { Interaction } from '../types';
import { api } from '../services/api';

export function useInteractions() {
    const [interactions, setInteractions] = createSignal<Interaction[]>([]);
    const [loading, setLoading] = createSignal(true);

    // Load initial history
    async function loadHistory() {
        setLoading(true);
        try {
            const history = await api.getHistory();
            setInteractions(history);
        } catch (error) {
            console.error('Failed to load history:', error);
        } finally {
            setLoading(false);
        }
    }

    // Connect to SSE stream
    createEffect(() => {
        const unsubscribe = api.connectToStream((event) => {
            if (event.type === 'init') {
                setInteractions(event.data);
                setLoading(false);
            } else if (event.type === 'interaction') {
                setInteractions(prev => {
                    const existing = prev.findIndex(i => i.id === event.data.id);
                    if (existing >= 0) {
                        // Update existing
                        const updated = [...prev];
                        updated[existing] = event.data;
                        return updated;
                    } else {
                        // Add new
                        return [...prev, event.data];
                    }
                });
            } else if (event.type === 'clear') {
                setInteractions([]);
            }
        });

        onCleanup(unsubscribe);
    });

    // Note: loadHistory() is not called here because the SSE stream
    // already sends the complete initial history via the 'init' event

    async function clearHistory() {
        await api.clearHistory();
    }

    async function refresh() {
        await loadHistory();
    }

    const stats = createMemo(() => ({
        total: interactions().length,
        actions: interactions().filter(i => i.screenshot).length,
    }));

    return {
        interactions,
        loading,
        stats,
        clearHistory,
        refresh,
    };
}
