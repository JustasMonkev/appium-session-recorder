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

function optionalType(value: unknown, type: 'string' | 'boolean'): boolean {
    return value === undefined || typeof value === type;
}

const ACTION_KINDS: ReadonlySet<unknown> = new Set([
    'tap', 'type', 'clear', 'back', 'forward', 'refresh', 'swipe', 'find', 'unknown',
]);
const CAPTURE_STATUSES: ReadonlySet<unknown> = new Set(['pending', 'complete', 'partial', 'failed', 'skipped']);

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isInteraction(value: unknown): value is Interaction {
    const interaction = asRecord(value);
    if (!interaction) return false;
    const elementInfo = interaction.elementInfo === undefined ? undefined : asRecord(interaction.elementInfo);
    return isPositiveInteger(interaction.id)
        && typeof interaction.timestamp === 'string'
        && typeof interaction.method === 'string'
        && typeof interaction.path === 'string'
        && optionalType(interaction.screenshotUrl, 'string')
        && optionalType(interaction.source, 'string')
        && optionalType(interaction.detailsUrl, 'string')
        && optionalType(interaction.detailsTruncated, 'boolean')
        && (
            interaction.elementInfo === undefined
            || (
                elementInfo !== undefined
                && typeof elementInfo.using === 'string'
                && typeof elementInfo.value === 'string'
            )
        )
        && (
            interaction.actionKind === undefined
            || ACTION_KINDS.has(interaction.actionKind)
        )
        && (
            interaction.captureStatus === undefined
            || CAPTURE_STATUSES.has(interaction.captureStatus)
        );
}

export async function fetchInteraction(url: string, signal?: AbortSignal): Promise<Interaction> {
    const match = url.match(/^\/_recorder\/api\/interaction\/([1-9]\d*)$/);
    if (!match) {
        throw new Error('Invalid interaction details URL');
    }
    const response = await fetch(url, { signal, credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Interaction details request failed (${response.status})`);
    const interaction: unknown = await response.json();
    if (
        !isInteraction(interaction)
        || interaction.id !== Number(match[1])
        || interaction.detailsTruncated === true
    ) {
        throw new Error('Interaction details response was invalid');
    }
    return interaction;
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
            && evict.ids.every(isPositiveInteger)
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
