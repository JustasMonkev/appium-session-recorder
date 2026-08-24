import type { Point } from '../types';
import { isXmlWithinLimits } from '../xml/xml-limits';

const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
export const MIN_GESTURE_DURATION_MS = 50;

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    // SAFETY: the runtime guard above narrows value to a non-array object with string-key access.
    return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseWindowSize(value: unknown): { width: number; height: number } | null {
    const candidate = asRecord(value);
    if (!candidate) return null;

    const width = Number(candidate.width);
    const height = Number(candidate.height);
    return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
        ? { width, height }
        : null;
}

async function readJson(response: Response): Promise<unknown> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new AppiumCommandError(
            'Appium response exceeded 20 MiB',
            'APPIUM_RESPONSE_TOO_LARGE',
            502,
        );
    }

    if (!response.body) return null;

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new AppiumCommandError(
                'Appium response exceeded 20 MiB',
                'APPIUM_RESPONSE_TOO_LARGE',
                502,
            );
        }
        chunks.push(value);
    }

    if (total === 0) return null;

    try {
        return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
    } catch {
        throw new AppiumCommandError(
            'Appium returned invalid JSON',
            'APPIUM_INVALID_RESPONSE',
            502,
        );
    }
}

export function isSafeAppiumUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return value === value.trim()
            && ['http:', 'https:'].includes(url.protocol)
            && !url.username
            && !url.password
            && !value.includes('?')
            && !value.includes('#');
    } catch {
        /* malformed URLs are unsafe */
        return false;
    }
}

export class AppiumCommandClient {
    private readonly appiumUrl: string;

    constructor(appiumUrl: string) {
        if (!isSafeAppiumUrl(appiumUrl)) {
            throw new AppiumCommandError(
                'Appium URL must be HTTP(S) without credentials, query, or fragment',
                'INVALID_APPIUM_URL',
                400,
            );
        }
        const url = new URL(appiumUrl);
        this.appiumUrl = url.href.replace(/\/$/, '');
    }

    private async send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
        let response: Response;
        const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        try {
            response = await fetch(`${this.appiumUrl}${path}`, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
            });
            const data = await readJson(response);
            if (!response.ok) {
                const envelope = asRecord(data);
                const value = asRecord(envelope?.value);
                throw new AppiumCommandError(
                    stringValue(value?.message)
                        ?? stringValue(envelope?.message)
                        ?? `Appium request failed (${response.status})`,
                    stringValue(value?.error) ?? 'APPIUM_REQUEST_FAILED',
                    response.status,
                    data,
                );
            }
            return data;
        } catch (error) {
            if (error instanceof AppiumCommandError) throw error;
            const timedOut = timeoutSignal.aborted || (error instanceof Error && error.name === 'TimeoutError');
            const aborted = !timedOut && signal?.aborted;
            throw new AppiumCommandError(
                timedOut ? 'Appium request timed out' : aborted ? 'Appium request aborted' : 'Unable to reach Appium',
                timedOut ? 'APPIUM_REQUEST_TIMEOUT' : aborted ? 'APPIUM_REQUEST_ABORTED' : 'APPIUM_REQUEST_FAILED',
                timedOut ? 504 : aborted ? 499 : 502,
                error,
            );
        }
    }

    private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
        const data = await this.send(method, path, body, signal);
        const envelope = asRecord(data);
        return envelope && 'value' in envelope ? envelope.value : data;
    }

    private sessionPath(sessionId: string, suffix = ''): string {
        return `/session/${encodeURIComponent(sessionId)}${suffix}`;
    }

    private async tryGetWindowSize(
        sessionId: string,
        endpoint: '/window/rect' | '/window/size',
    ): Promise<{ width: number; height: number } | null> {
        try {
            return parseWindowSize(await this.request('GET', this.sessionPath(sessionId, endpoint)));
        } catch (error) {
            if (
                error instanceof AppiumCommandError
                && error.code.toLowerCase() === 'unknown command'
            ) return null;
            throw error;
        }
    }

    private async getWindowSize(sessionId: string): Promise<{ width: number; height: number }> {
        const rect = await this.tryGetWindowSize(sessionId, '/window/rect');
        if (rect) return rect;

        const size = await this.tryGetWindowSize(sessionId, '/window/size');
        if (size) return size;

        throw new AppiumCommandError(
            'Unable to determine window size for scroll gesture',
            'WINDOW_SIZE_UNAVAILABLE',
            500,
        );
    }

    async createSession(caps: unknown): Promise<{ sessionId: string; value: unknown }> {
        const capabilities = asRecord(caps);
        if (!capabilities) {
            throw new AppiumCommandError(
                'Capabilities must be a JSON object',
                'INVALID_CAPABILITIES',
                400,
            );
        }

        const payload = 'capabilities' in capabilities
            ? capabilities
            : {
                  capabilities: {
                      alwaysMatch: capabilities,
                      firstMatch: [{}],
                  },
              };
        const data = await this.send('POST', '/session', payload);
        const envelope = asRecord(data);
        const value = asRecord(envelope?.value);
        const sessionId = stringValue(envelope?.sessionId) ?? stringValue(value?.sessionId);
        if (!sessionId) {
            throw new AppiumCommandError(
                'Appium did not return a sessionId',
                'APPIUM_SESSION_ID_MISSING',
                502,
                data,
            );
        }

        return { sessionId, value: envelope?.value };
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.request('DELETE', this.sessionPath(sessionId));
    }

    async getSource(sessionId: string, signal?: AbortSignal): Promise<string> {
        const source = await this.request('GET', this.sessionPath(sessionId, '/source'), undefined, signal);
        if (typeof source !== 'string') {
            throw new AppiumCommandError('Appium source was not a string', 'APPIUM_INVALID_RESPONSE', 502, source);
        }
        if (!isXmlWithinLimits(source)) {
            throw new AppiumCommandError('Appium source was not valid bounded XML', 'APPIUM_INVALID_SOURCE', 502, source);
        }
        return source;
    }

    async getScreenshot(sessionId: string, signal?: AbortSignal): Promise<string> {
        const screenshot = await this.request('GET', this.sessionPath(sessionId, '/screenshot'), undefined, signal);
        const decoded = typeof screenshot === 'string' ? Buffer.from(screenshot, 'base64') : undefined;
        if (
            typeof screenshot !== 'string'
            || screenshot.length === 0
            || screenshot.length % 4 !== 0
            || !/^[A-Za-z0-9+/]*={0,2}$/.test(screenshot)
            || !decoded
            || decoded.length === 0
            || decoded.toString('base64') !== screenshot
        ) {
            throw new AppiumCommandError(
                'Appium screenshot was not valid base64',
                'APPIUM_INVALID_RESPONSE',
                502,
                screenshot,
            );
        }
        return screenshot;
    }

    async captureState(sessionId: string): Promise<{ source?: string; screenshot?: string }> {
        const controller = new AbortController();
        let firstError: unknown;
        const settle = async <T>(request: Promise<T>): Promise<T> => {
            try {
                return await request;
            } catch (error) {
                if (firstError === undefined) {
                    firstError = error;
                    controller.abort();
                }
                throw error;
            }
        };
        const results = await Promise.allSettled([
            settle(this.getSource(sessionId, controller.signal)),
            settle(this.getScreenshot(sessionId, controller.signal)),
        ]);
        const [source, screenshot] = results;
        const state: { source?: string; screenshot?: string } = {};
        if (source.status === 'fulfilled') state.source = source.value;
        if (screenshot.status === 'fulfilled') state.screenshot = screenshot.value;
        if (state.source || state.screenshot) return state;
        if (firstError !== undefined) throw firstError;
        throw new AppiumCommandError('Unable to capture Appium state', 'APPIUM_REQUEST_FAILED', 502);
    }

    async findElement(sessionId: string, using: string, value: string): Promise<string> {
        const result = asRecord(await this.request(
            'POST',
            this.sessionPath(sessionId, '/element'),
            { using, value },
        ));
        const elementId = stringValue(result?.[W3C_ELEMENT_KEY]) ?? stringValue(result?.ELEMENT);
        if (!elementId) {
            throw new AppiumCommandError(
                'Element not found',
                'ELEMENT_NOT_FOUND',
                404,
                { using, value },
            );
        }
        return elementId;
    }

    async tap(sessionId: string, using: string, value: string): Promise<void> {
        await this.tapElement(sessionId, await this.findElement(sessionId, using, value));
    }

    async tapElement(sessionId: string, elementId: string): Promise<void> {
        await this.request(
            'POST',
            this.sessionPath(sessionId, `/element/${encodeURIComponent(elementId)}/click`),
            {},
        );
    }

    async clear(sessionId: string, using: string, value: string): Promise<void> {
        await this.clearElement(sessionId, await this.findElement(sessionId, using, value));
    }

    async clearElement(sessionId: string, elementId: string): Promise<void> {
        await this.request(
            'POST',
            this.sessionPath(sessionId, `/element/${encodeURIComponent(elementId)}/clear`),
            {},
        );
    }

    async type(
        sessionId: string,
        using: string,
        value: string,
        text: string,
        clearFirst: boolean,
    ): Promise<void> {
        const elementId = await this.findElement(sessionId, using, value);
        if (clearFirst) await this.clearElement(sessionId, elementId);
        await this.typeElement(sessionId, elementId, text);
    }

    async typeElement(sessionId: string, elementId: string, text: string): Promise<void> {
        await this.request(
            'POST',
            this.sessionPath(sessionId, `/element/${encodeURIComponent(elementId)}/value`),
            { text, value: [...text] },
        );
    }

    async back(sessionId: string): Promise<void> {
        await this.request('POST', this.sessionPath(sessionId, '/back'), {});
    }

    async swipe(sessionId: string, from: Point, to: Point, durationMs: number): Promise<void> {
        if (!Number.isInteger(durationMs) || durationMs < MIN_GESTURE_DURATION_MS) {
            throw new AppiumCommandError(
                `Gesture duration must be an integer of at least ${MIN_GESTURE_DURATION_MS} ms`,
                'INVALID_GESTURE_DURATION',
                400,
            );
        }
        const duration = durationMs;
        let actionError: unknown;
        try {
            await this.request('POST', this.sessionPath(sessionId, '/actions'), {
                actions: [{
                    type: 'pointer',
                    id: 'finger1',
                    parameters: { pointerType: 'touch' },
                    actions: [
                        { type: 'pointerMove', duration: 0, x: from.x, y: from.y },
                        { type: 'pointerDown', button: 0 },
                        { type: 'pause', duration: MIN_GESTURE_DURATION_MS },
                        { type: 'pointerMove', duration, x: to.x, y: to.y },
                        { type: 'pointerUp', button: 0 },
                    ],
                }],
            });
        } catch (error) {
            actionError = error;
        }

        try {
            await this.request('DELETE', this.sessionPath(sessionId, '/actions'));
        } catch (error) {
            if (!actionError) throw error;
        }
        if (actionError) throw actionError;
    }

    async scroll(
        sessionId: string,
        direction: 'up' | 'down' | 'left' | 'right',
        durationMs = 300,
    ): Promise<void> {
        const { width, height } = await this.getWindowSize(sessionId);
        const centerX = Math.round(width * 0.5);
        const centerY = Math.round(height * 0.5);
        const startY = Math.round(height * 0.8);
        const endY = Math.round(height * 0.2);
        const startX = Math.round(width * 0.8);
        const endX = Math.round(width * 0.2);
        const coords: Record<typeof direction, { from: Point; to: Point }> = {
            down: { from: { x: centerX, y: startY }, to: { x: centerX, y: endY } },
            up: { from: { x: centerX, y: endY }, to: { x: centerX, y: startY } },
            left: { from: { x: startX, y: centerY }, to: { x: endX, y: centerY } },
            right: { from: { x: endX, y: centerY }, to: { x: startX, y: centerY } },
        };

        const { from, to } = coords[direction];
        await this.swipe(sessionId, from, to, durationMs);
    }
}
