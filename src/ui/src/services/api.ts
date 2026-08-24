import type { Interaction } from '../types';
import type { ServerEvent } from '../../../server/types';

export type StreamEvent = ServerEvent | { type: 'init'; data: Interaction[] };

export type StreamEventParseResult =
    | { ok: true; event: StreamEvent }
    | { ok: false };

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    // SAFETY: the runtime guard above narrows value to a non-array object with string-key access.
    return value as Record<string, unknown>;
}

function isInteraction(value: unknown): value is Interaction {
    const interaction = asRecord(value);
    if (!interaction) return false;
    return Number.isInteger(interaction.id)
        && typeof interaction.timestamp === 'string'
        && typeof interaction.method === 'string'
        && typeof interaction.path === 'string';
}

export async function fetchInteraction(url: string, signal?: AbortSignal): Promise<Interaction> {
    if (!/^\/_recorder\/api\/interaction\/[1-9]\d*$/.test(url)) {
        throw new Error('Invalid interaction details URL');
    }
    const response = await fetch(url, { signal, credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Interaction details request failed (${response.status})`);
    const interaction: unknown = await response.json();
    if (!isInteraction(interaction)) throw new Error('Interaction details response was invalid');
    return interaction;
}

function isInteger(value: unknown): value is number {
    return Number.isInteger(value);
}

export function parseStreamEvent(serialized: string): StreamEventParseResult {
    try {
        const parsed = asRecord(JSON.parse(serialized));
        if (parsed?.type === 'init' && Array.isArray(parsed.data) && parsed.data.every(isInteraction)) {
            return { ok: true, event: { type: 'init', data: parsed.data } };
        }
        if (parsed?.type === 'interaction' && isInteraction(parsed.data)) {
            return { ok: true, event: { type: 'interaction', data: parsed.data } };
        }
        if (parsed?.type === 'clear' && parsed.data === null) {
            return { ok: true, event: { type: 'clear', data: null } };
        }
        const evict = asRecord(parsed?.data);
        if (
            parsed?.type === 'evict'
            && Array.isArray(evict?.ids)
            && evict.ids.every(isInteger)
        ) {
            return { ok: true, event: { type: 'evict', data: { ids: evict.ids } } };
        }
        return { ok: false };
    } catch {
        return { ok: false };
    }
}

export function connectToStream(onEvent: (event: StreamEvent) => void): () => void {
    const eventSource = new EventSource('/_recorder/api/stream');

    eventSource.onmessage = (event) => {
        const parsed = parseStreamEvent(event.data);
        if (parsed.ok) onEvent(parsed.event);
        else console.error('Invalid SSE event');
    };

    eventSource.onerror = (error) => {
        console.error('SSE connection error:', error);
    };

    return () => eventSource.close();
}
