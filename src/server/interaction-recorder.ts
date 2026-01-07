import type { Interaction, ServerEvent } from './types';

export class InteractionRecorder {
    private history: Interaction[] = [];
    private interactionId = 0;
    private listeners: Set<(event: ServerEvent) => void> = new Set();

    shouldRecord(method: string, path: string): boolean {
        if (method === 'POST') {
            return true;
        }
        return false;
    }

    isActionEndpoint(method: string, path: string): boolean {
        const actionPatterns = [
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

        if (method === 'POST' || method === 'DELETE') {
            return actionPatterns.some(pattern => pattern.test(path));
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
        this.emit({ type: 'interaction', data: fullInteraction });

        return fullInteraction;
    }

    updateInteraction(id: number, updates: Partial<Interaction>): void {
        const interaction = this.history.find(i => i.id === id);
        if (interaction) {
            Object.assign(interaction, updates);
            this.emit({ type: 'interaction', data: interaction });
        }
    }

    getHistory(): Interaction[] {
        return this.history;
    }

    clearHistory(): void {
        this.history = [];
        this.interactionId = 0;
        this.emit({ type: 'clear', data: null });
    }

    on(listener: (event: ServerEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(event: ServerEvent): void {
        this.listeners.forEach(listener => listener(event));
    }
}
