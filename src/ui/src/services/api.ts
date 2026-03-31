import type { Interaction, ReplayResult } from '../types';

class ApiClient {
    async getHistory(): Promise<Interaction[]> {
        const response = await fetch('/_recorder/api/history');

        if(!response.ok) {
            throw new Error(`Failed to fetch history: ${response.statusText}`);
        }

        return response.json();
    }

    async clearHistory(): Promise<void> {
        const response = await fetch('/_recorder/api/clear', { method: 'POST' });
        if(!response.ok) {
            throw new Error(`Failed to clear history: ${response.statusText}`);
        }
    }

    async replayInteraction(
        interactionId: number,
        overrides?: {
            sessionId?: string;
            selector?: { using: string; value: string };
            text?: string;
            direction?: 'up' | 'down' | 'left' | 'right';
            from?: { x: number; y: number };
            to?: { x: number; y: number };
            durationMs?: number;
        },
    ): Promise<ReplayResult> {
        const response = await fetch(`/_recorder/api/interactions/${interactionId}/replay`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(overrides || {}),
        });

        return response.json();
    }

    connectToStream(onEvent: (event: any) => void): () => void {
        const eventSource = new EventSource('/_recorder/api/stream');

        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                onEvent(data);
            } catch (error) {
                console.error('Failed to parse SSE event:', error);
            }
        };

        eventSource.onerror = (error) => {
            console.error('SSE connection error:', error);
        };

        return () => eventSource.close();
    }
}

export const api = new ApiClient();
