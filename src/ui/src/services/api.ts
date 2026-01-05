import type { Interaction } from '../types';

class ApiClient {
    async getHistory(): Promise<Interaction[]> {
        const response = await fetch('/_recorder/api/history');
        return response.json();
    }

    async clearHistory(): Promise<void> {
        await fetch('/_recorder/api/history', { method: 'DELETE' });
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
