import type { CapturedState, Interaction, ServerEvent } from './types';
import { isSourceWithinLimits } from '../core/xml/xml-limits';

const MAX_HISTORY = 500;
const MAX_RETAINED_BYTES = 100 * 1024 * 1024;

export type ServerEventListener = (event: ServerEvent) => void;

export function classifyAction(method: string, path: string): Interaction['actionKind'] {
    if (method !== 'POST') return 'unknown';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    if (/\/element\/[^/]+\/click$/.test(path)) return 'tap';
    if (/\/element\/[^/]+\/value$/.test(path)) return 'type';
    if (/\/element\/[^/]+\/clear$/.test(path)) return 'clear';
    if (/\/elements?$/.test(path)) return 'find';
    if (/\/(?:touch\/perform|actions)$/.test(path)) return 'swipe';
    if (/\/back$/.test(path)) return 'back';
    if (/\/forward$/.test(path)) return 'forward';
    if (/\/refresh$/.test(path)) return 'refresh';
    return 'unknown';
}

export class InteractionRecorder {
    private history: Interaction[] = [];
    private readonly byId = new Map<number, Interaction>();
    private readonly screenshots = new Map<number, Buffer>();
    private readonly bytesById = new Map<number, number>();
    private retainedBytes = 0;
    private interactionId = 0;
    private validatedSource?: { id: number; value: string };
    private readonly listeners = new Set<ServerEventListener>();

    recordInteraction(interaction: Omit<Interaction, 'id' | 'timestamp'>): Interaction {
        const fullInteraction: Interaction = {
            id: this.interactionId + 1,
            timestamp: new Date().toISOString(),
            method: interaction.method,
            path: interaction.path,
        };
        if (interaction.screenshotUrl) fullInteraction.screenshotUrl = interaction.screenshotUrl;
        if (interaction.source) fullInteraction.source = interaction.source;
        if (interaction.elementInfo) fullInteraction.elementInfo = interaction.elementInfo;
        if (interaction.actionKind) fullInteraction.actionKind = interaction.actionKind;
        if (interaction.captureStatus) fullInteraction.captureStatus = interaction.captureStatus;
        const bytes = Buffer.byteLength(JSON.stringify(fullInteraction));
        const event: ServerEvent = { type: 'interaction', data: fullInteraction };
        this.interactionId = fullInteraction.id;
        this.history.push(fullInteraction);
        this.byId.set(fullInteraction.id, fullInteraction);
        this.bytesById.set(fullInteraction.id, bytes);
        this.retainedBytes += bytes;

        const evictedIds = this.evictOverflow();

        this.emit(event);
        if (evictedIds.length > 0) {
            this.emit({ type: 'evict', data: { ids: evictedIds } });
        }

        return fullInteraction;
    }

    attachCapturedState(id: number, state: CapturedState): void {
        const interaction = this.byId.get(id);
        if (!interaction) return;

        if (state.screenshot) {
            this.screenshots.set(id, Buffer.from(state.screenshot, 'base64'));
            interaction.screenshotUrl = `/_recorder/api/screenshot/${id}?v=${Date.now()}`;
        }
        if (
            state.source
            && (state.source === this.validatedSource?.value || isSourceWithinLimits(state.source))
        ) {
            interaction.source = state.source;
            this.validatedSource = { id, value: state.source };
        }
        interaction.captureStatus = interaction.source && interaction.screenshotUrl
            ? 'complete'
            : interaction.source || interaction.screenshotUrl ? 'partial' : 'failed';

        const previousBytes = this.bytesById.get(id) ?? 0;
        const bytes = Buffer.byteLength(JSON.stringify(interaction)) + (this.screenshots.get(id)?.length ?? 0);
        this.bytesById.set(id, bytes);
        this.retainedBytes += bytes - previousBytes;

        const evictedIds = this.evictOverflow();
        if (this.byId.has(id)) this.emit({ type: 'interaction', data: interaction });
        if (evictedIds.length > 0) this.emit({ type: 'evict', data: { ids: evictedIds } });
    }

    getScreenshot(id: number): Buffer | undefined {
        return this.screenshots.get(id);
    }

    getInteraction(id: number): Interaction | undefined {
        return this.byId.get(id);
    }

    markCaptureUnavailable(id: number, status: 'failed' | 'skipped'): void {
        const interaction = this.byId.get(id);
        if (!interaction) return;
        interaction.captureStatus = status;

        const previousBytes = this.bytesById.get(id) ?? 0;
        const bytes = Buffer.byteLength(JSON.stringify(interaction)) + (this.screenshots.get(id)?.length ?? 0);
        this.bytesById.set(id, bytes);
        this.retainedBytes += bytes - previousBytes;

        const evictedIds = this.evictOverflow();
        if (this.byId.has(id)) this.emit({ type: 'interaction', data: interaction });
        if (evictedIds.length > 0) this.emit({ type: 'evict', data: { ids: evictedIds } });
    }

    getHistory(): Interaction[] {
        return this.history;
    }

    clearHistory(): void {
        this.history = [];
        this.byId.clear();
        this.screenshots.clear();
        this.bytesById.clear();
        this.retainedBytes = 0;
        this.validatedSource = undefined;
        this.emit({ type: 'clear', data: null });
    }

    on(listener: ServerEventListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(event: ServerEvent): void {
        this.listeners.forEach(listener => listener(event));
    }

    private evictOverflow(): number[] {
        const evictedIds: number[] = [];
        while (this.history.length > MAX_HISTORY || this.retainedBytes > MAX_RETAINED_BYTES) {
            const evicted = this.history.shift();
            if (!evicted) break;

            this.byId.delete(evicted.id);
            this.screenshots.delete(evicted.id);
            this.retainedBytes -= this.bytesById.get(evicted.id) ?? 0;
            this.bytesById.delete(evicted.id);
            if (this.validatedSource?.id === evicted.id) this.validatedSource = undefined;
            evictedIds.push(evicted.id);
        }
        return evictedIds;
    }
}
