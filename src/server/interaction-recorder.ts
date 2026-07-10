import type { CapturedState, Interaction, ServerEvent } from './types';

const ACTION_PATTERNS: readonly RegExp[] = [
    /\/element\/[^/]+\/click$/,
    /\/element\/[^/]+\/value$/,
    /\/element\/[^/]+\/clear$/,
    /\/element$/,
    /\/elements$/,
    /\/touch\/perform$/,
    /\/actions$/,
    /\/back$/,
    /\/forward$/,
    /\/refresh$/,
];

// Upper bound on retained interactions so long sessions don't grow memory
// without limit (each action carries a screenshot and a full XML source).
const MAX_HISTORY = 500;

export type ServerEventListener = (event: ServerEvent, serialized: string) => void;

export class InteractionRecorder {
    private history: Interaction[] = [];
    private byId = new Map<number, Interaction>();
    private screenshots = new Map<number, Buffer>();
    private interactionId = 0;
    private listeners: Set<ServerEventListener> = new Set();

    shouldRecord(method: string, path: string): boolean {
        if (method === 'POST') {
            return true;
        }
        return false;
    }

    isActionEndpoint(method: string, path: string): boolean {
        if (method === 'POST' || method === 'DELETE') {
            return ACTION_PATTERNS.some(pattern => pattern.test(path));
        }
        return false;
    }

    recordInteraction(interaction: Omit<Interaction, 'id' | 'timestamp'>): Interaction {
        const fullInteraction: Interaction = {
            id: ++this.interactionId,
            timestamp: new Date().toISOString(),
            ...interaction,
        };

        this.history.push(fullInteraction);
        this.byId.set(fullInteraction.id, fullInteraction);

        const evictedIds: number[] = [];
        while (this.history.length > MAX_HISTORY) {
            const evicted = this.history.shift()!;
            this.byId.delete(evicted.id);
            this.screenshots.delete(evicted.id);
            evictedIds.push(evicted.id);
        }

        this.emit({ type: 'interaction', data: fullInteraction });
        if (evictedIds.length > 0) {
            this.emit({ type: 'evict', data: { ids: evictedIds } });
        }

        return fullInteraction;
    }

    updateInteraction(id: number, updates: Partial<Interaction>): void {
        const interaction = this.byId.get(id);
        if (interaction) {
            Object.assign(interaction, updates);
            this.emit({ type: 'interaction', data: interaction });
        }
    }

    /**
     * Attach a captured screenshot/source to an interaction. The screenshot is
     * stored as a decoded Buffer and exposed via `screenshotUrl` instead of
     * being embedded as base64 in every history/SSE payload.
     */
    attachCapturedState(id: number, state: CapturedState): void {
        const interaction = this.byId.get(id);
        if (!interaction) return;

        if (state.screenshot) {
            this.screenshots.set(id, Buffer.from(state.screenshot, 'base64'));
            // The capture-time token makes the URL unique even if interaction
            // ids are reused (clearHistory resets the counter, and ids restart
            // across server runs), so immutable caching can never serve a
            // stale screenshot for a new capture.
            interaction.screenshotUrl = `/_recorder/api/screenshot/${id}?v=${Date.now()}`;
        }
        if (state.source) {
            interaction.source = state.source;
        }

        this.emit({ type: 'interaction', data: interaction });
    }

    getScreenshot(id: number): Buffer | undefined {
        return this.screenshots.get(id);
    }

    getHistory(): Interaction[] {
        return this.history;
    }

    clearHistory(): void {
        this.history = [];
        this.byId.clear();
        this.screenshots.clear();
        this.interactionId = 0;
        this.emit({ type: 'clear', data: null });
    }

    on(listener: ServerEventListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(event: ServerEvent): void {
        // Serialize once so every SSE client doesn't re-stringify the payload.
        const serialized = JSON.stringify(event);
        this.listeners.forEach(listener => listener(event, serialized));
    }
}
