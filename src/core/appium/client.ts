import type { Point } from '../types';

const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

export class AppiumCommandError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly status: number,
        public readonly details?: unknown,
    ) {
        super(message);
    }
}

export class AppiumCommandClient {
    constructor(private readonly appiumUrl: string) {}

    private parseWindowSize(value: unknown): { width: number; height: number } | null {
        if (!value || typeof value !== 'object') {
            return null;
        }

        const candidate = value as Record<string, unknown>;
        const width = Number(candidate.width);
        const height = Number(candidate.height);

        if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
            return null;
        }

        return { width, height };
    }

    private async tryGetWindowSize(sessionId: string, endpoint: '/window/rect' | '/window/size'): Promise<{ width: number; height: number } | null> {
        try {
            const result = await this.request<unknown>('GET', `/session/${sessionId}${endpoint}`);
            return this.parseWindowSize(result);
        } catch {
            return null;
        }
    }

    private async getWindowSize(sessionId: string): Promise<{ width: number; height: number }> {
        const rect = await this.tryGetWindowSize(sessionId, '/window/rect');
        if (rect) {
            return rect;
        }

        const size = await this.tryGetWindowSize(sessionId, '/window/size');
        if (size) {
            return size;
        }

        throw new AppiumCommandError(
            'Unable to determine window size for scroll gesture',
            'WINDOW_SIZE_UNAVAILABLE',
            500,
        );
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const response = await fetch(`${this.appiumUrl}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        let data: any = null;
        try {
            data = await response.json();
        } catch {
            data = null;
        }

        if (!response.ok) {
            const errorMessage = data?.value?.message || data?.message || `Appium request failed (${response.status})`;
            const errorCode = data?.value?.error || 'APPIUM_REQUEST_FAILED';
            throw new AppiumCommandError(errorMessage, errorCode, response.status, data);
        }

        if (data && typeof data === 'object' && 'value' in data) {
            return data.value as T;
        }

        return data as T;
    }

    async createSession(caps: Record<string, unknown>): Promise<{ sessionId: string; value: unknown }> {
        const payload = 'capabilities' in caps
            ? caps
            : {
                  capabilities: {
                      alwaysMatch: caps,
                      firstMatch: [{}],
                  },
              };

        const response = await fetch(`${this.appiumUrl}/session`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        const data: any = await response.json();

        if (!response.ok) {
            const errorMessage = data?.value?.message || data?.message || `Failed to create session (${response.status})`;
            const errorCode = data?.value?.error || 'APPIUM_SESSION_CREATE_FAILED';
            throw new AppiumCommandError(errorMessage, errorCode, response.status, data);
        }

        const sessionId = data?.sessionId || data?.value?.sessionId;
        if (!sessionId) {
            throw new AppiumCommandError('Appium did not return a sessionId', 'APPIUM_SESSION_ID_MISSING', 500, data);
        }

        return {
            sessionId,
            value: data?.value,
        };
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.request('DELETE', `/session/${sessionId}`);
    }

    async getSource(sessionId: string): Promise<string> {
        return await this.request<string>('GET', `/session/${sessionId}/source`);
    }

    async getScreenshot(sessionId: string): Promise<string> {
        return await this.request<string>('GET', `/session/${sessionId}/screenshot`);
    }

    async captureState(sessionId: string): Promise<{ source: string; screenshot: string }> {
        const [source, screenshot] = await Promise.all([
            this.getSource(sessionId),
            this.getScreenshot(sessionId),
        ]);

        return {
            source,
            screenshot,
        };
    }

    async findElement(sessionId: string, using: string, value: string): Promise<string> {
        const result = await this.request<Record<string, string>>('POST', `/session/${sessionId}/element`, {
            using,
            value,
        });

        return result[W3C_ELEMENT_KEY] || result.ELEMENT;
    }

    async tap(sessionId: string, using: string, value: string): Promise<void> {
        const elementId = await this.findElement(sessionId, using, value);
        if (!elementId) {
            throw new AppiumCommandError('Element not found for tap command', 'ELEMENT_NOT_FOUND', 404, {
                using,
                value,
            });
        }

        await this.request('POST', `/session/${sessionId}/element/${elementId}/click`, {});
    }

    async clear(sessionId: string, using: string, value: string): Promise<void> {
        const elementId = await this.findElement(sessionId, using, value);
        if (!elementId) {
            throw new AppiumCommandError('Element not found for clear command', 'ELEMENT_NOT_FOUND', 404, {
                using,
                value,
            });
        }
        await this.request('POST', `/session/${sessionId}/element/${elementId}/clear`, {});
    }

    async type(sessionId: string, using: string, value: string, text: string, clearFirst: boolean): Promise<void> {
        const elementId = await this.findElement(sessionId, using, value);
        if (!elementId) {
            throw new AppiumCommandError('Element not found for type command', 'ELEMENT_NOT_FOUND', 404, {
                using,
                value,
            });
        }

        if (clearFirst) {
            await this.request('POST', `/session/${sessionId}/element/${elementId}/clear`, {});
        }

        await this.request('POST', `/session/${sessionId}/element/${elementId}/value`, {
            text,
            value: [...text],
        });
    }

    async back(sessionId: string): Promise<void> {
        await this.request('POST', `/session/${sessionId}/back`, {});
    }

    async swipe(sessionId: string, from: Point, to: Point, durationMs: number): Promise<void> {
        await this.request('POST', `/session/${sessionId}/actions`, {
            actions: [
                {
                    type: 'pointer',
                    id: 'finger1',
                    parameters: { pointerType: 'touch' },
                    actions: [
                        { type: 'pointerMove', duration: 0, x: from.x, y: from.y },
                        { type: 'pointerDown', button: 0 },
                        { type: 'pause', duration: Math.max(50, durationMs) },
                        { type: 'pointerMove', duration: Math.max(50, durationMs), x: to.x, y: to.y },
                        { type: 'pointerUp', button: 0 },
                    ],
                },
            ],
        });

        await this.request('DELETE', `/session/${sessionId}/actions`);
    }

    async scroll(sessionId: string, direction: 'up' | 'down' | 'left' | 'right', durationMs = 300): Promise<void> {
        const { width, height } = await this.getWindowSize(sessionId);

        const centerX = Math.round(width * 0.5);
        const centerY = Math.round(height * 0.5);
        const startY = Math.round(height * 0.8);
        const endY = Math.round(height * 0.2);
        const startX = Math.round(width * 0.8);
        const endX = Math.round(width * 0.2);

        const coords: Record<'up' | 'down' | 'left' | 'right', { from: Point; to: Point }> = {
            down: { from: { x: centerX, y: startY }, to: { x: centerX, y: endY } },
            up: { from: { x: centerX, y: endY }, to: { x: centerX, y: startY } },
            left: { from: { x: startX, y: centerY }, to: { x: endX, y: centerY } },
            right: { from: { x: endX, y: centerY }, to: { x: startX, y: centerY } },
        };

        const { from, to } = coords[direction];
        await this.swipe(sessionId, from, to, durationMs);
    }
}
