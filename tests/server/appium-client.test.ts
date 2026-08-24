import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppiumCommandClient, AppiumCommandError } from '../../src/core/appium/client';

const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

let fetchMock = vi.fn<typeof fetch>();

describe('AppiumCommandClient', () => {
    let client: AppiumCommandClient;

    beforeEach(() => {
        fetchMock = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetchMock);
        client = new AppiumCommandClient('http://localhost:4723');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each([
        'not a URL',
        'file:///tmp/appium.sock',
        'http://user:password@localhost:4723',
        'http://localhost:4723?token=value',
        'http://localhost:4723?',
        'http://localhost:4723#fragment',
        'http://localhost:4723#',
        ' http://localhost:4723',
    ])('rejects unsafe Appium URL %s', appiumUrl => {
        expect(() => new AppiumCommandClient(appiumUrl)).toThrow(AppiumCommandError);
    });

    it('requests encoded session paths with a timeout signal', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ value: '<screen />' }));

        await expect(client.getSource('session /?')).resolves.toBe('<screen />');

        expect(fetchMock).toHaveBeenCalledWith(
            'http://localhost:4723/session/session%20%2F%3F/source',
            expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
        );
    });

    it('wraps plain capabilities in a W3C payload', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ sessionId: 'created', value: { ready: true } }));

        const result = await client.createSession({ platformName: 'iOS' });
        const request = fetchMock.mock.calls[0]?.[1];

        expect(result).toEqual({ sessionId: 'created', value: { ready: true } });
        expect(JSON.parse(String(request?.body))).toEqual({
            capabilities: {
                alwaysMatch: { platformName: 'iOS' },
                firstMatch: [{}],
            },
        });
    });

    it('preserves an existing W3C capabilities envelope', async () => {
        const capabilities = { capabilities: { alwaysMatch: { platformName: 'Android' } } };
        fetchMock.mockResolvedValue(jsonResponse({ value: { sessionId: 'nested' } }));

        await expect(client.createSession(capabilities)).resolves.toEqual({
            sessionId: 'nested',
            value: { sessionId: 'nested' },
        });
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(capabilities);
    });

    it.each([null, [], 'ios', 1, true])('rejects non-object capabilities: %j', async capabilities => {
        await expect(client.createSession(capabilities)).rejects.toMatchObject({
            code: 'INVALID_CAPABILITIES',
            status: 400,
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a session response without an id', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ value: { capabilities: {} } }));

        await expect(client.createSession({ platformName: 'iOS' })).rejects.toMatchObject({
            code: 'APPIUM_SESSION_ID_MISSING',
            status: 502,
        });
    });

    it('preserves structured Appium errors', async () => {
        const details = { value: { error: 'invalid selector', message: 'Bad XPath' } };
        fetchMock.mockResolvedValue(jsonResponse(details, 400));

        await expect(client.getSource('session')).rejects.toMatchObject({
            code: 'invalid selector',
            message: 'Bad XPath',
            status: 400,
            details,
        });
    });

    it('reports network and timeout failures distinctly', async () => {
        fetchMock.mockRejectedValueOnce(new Error('offline'));
        await expect(client.getSource('session')).rejects.toMatchObject({
            code: 'APPIUM_REQUEST_FAILED',
            status: 502,
        });

        fetchMock.mockRejectedValueOnce(new DOMException('expired', 'TimeoutError'));
        await expect(client.getSource('session')).rejects.toMatchObject({
            code: 'APPIUM_REQUEST_TIMEOUT',
            status: 504,
        });
    });

    it('rejects invalid JSON from a successful response', async () => {
        fetchMock.mockResolvedValue(new Response('{broken', { status: 200 }));

        await expect(client.getSource('session')).rejects.toMatchObject({
            code: 'APPIUM_INVALID_RESPONSE',
            status: 502,
        });
    });

    it('rejects a declared response larger than 20 MiB before reading it', async () => {
        fetchMock.mockResolvedValue(jsonResponse(
            { value: '<screen />' },
            200,
            { 'content-length': String(20 * 1024 * 1024 + 1) },
        ));

        await expect(client.getSource('session')).rejects.toMatchObject({
            code: 'APPIUM_RESPONSE_TOO_LARGE',
            status: 502,
        });
    });

    it('cancels a declared oversized response body', async () => {
        const cancelled = vi.fn();
        const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
        fetchMock.mockResolvedValue(new Response(body, {
            headers: { 'content-length': String(20 * 1024 * 1024 + 1) },
        }));

        await expect(client.getSource('session')).rejects.toMatchObject({ code: 'APPIUM_RESPONSE_TOO_LARGE' });
        expect(cancelled).toHaveBeenCalledOnce();
    });

    it('normalizes post-header body timeouts into a structured timeout error', async () => {
        const body = new ReadableStream<Uint8Array>({
            pull() {
                throw new DOMException('expired', 'TimeoutError');
            },
        });
        fetchMock.mockResolvedValue(new Response(body));

        await expect(client.getSource('session')).rejects.toMatchObject({
            code: 'APPIUM_REQUEST_TIMEOUT',
            status: 504,
        });
    });

    it('stops a streamed response after it exceeds 20 MiB', async () => {
        let chunks = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(1024 * 1024));
                chunks++;
                if (chunks === 21) controller.close();
            },
        });
        fetchMock.mockResolvedValue(new Response(body));

        await expect(client.getSource('session')).rejects.toMatchObject({
            code: 'APPIUM_RESPONSE_TOO_LARGE',
            status: 502,
        });
    });

    it('requires source responses to be strings', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ value: { xml: '<screen />' } }));

        await expect(client.getSource('session')).rejects.toMatchObject({
            code: 'APPIUM_INVALID_RESPONSE',
        });
    });

    it.each(['<a></b>', '<a/><b/>', 'junk<a/>junk'])('rejects malformed Appium source %s', async source => {
        fetchMock.mockResolvedValue(jsonResponse({ value: source }));
        await expect(client.getSource('session')).rejects.toMatchObject({ code: 'APPIUM_INVALID_SOURCE' });
    });

    it('preserves bounded HTML sources from web contexts', async () => {
        const source = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><input disabled></body></html>';
        fetchMock.mockResolvedValue(jsonResponse({ value: source }));

        await expect(client.getSource('session')).resolves.toBe(source);
    });

    it.each(['', 'a', 'A=', 'AA=', 'AB==', 'AAAA=', 'not base64!', 7, null])('rejects invalid screenshot payload %j', async screenshot => {
        fetchMock.mockResolvedValue(jsonResponse({ value: screenshot }));

        await expect(client.getScreenshot('session')).rejects.toMatchObject({
            code: 'APPIUM_INVALID_RESPONSE',
        });
    });

    it('captures source and screenshot concurrently', async () => {
        const screenshot = Buffer.from('png').toString('base64');
        fetchMock.mockImplementation(async input => String(input).endsWith('/source')
            ? jsonResponse({ value: '<screen />' })
            : jsonResponse({ value: screenshot }));

        const capture = client.captureState('session');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await expect(capture).resolves.toEqual({ source: '<screen />', screenshot });
    });

    it('preserves a completed screenshot when source capture fails afterward', async () => {
        const screenshot = Buffer.from('png').toString('base64');
        const screenshotCompleted = Promise.withResolvers<void>();
        fetchMock.mockImplementation(async input => {
            if (String(input).endsWith('/screenshot')) {
                screenshotCompleted.resolve();
                return jsonResponse({ value: screenshot });
            }
            await screenshotCompleted.promise;
            return jsonResponse({ value: { error: 'source failed', message: 'unavailable' } }, 500);
        });

        await expect(client.captureState('session')).resolves.toEqual({ screenshot });
    });

    it('aborts and awaits a stalled capture sibling after the first failure', async () => {
        const cancelled = Promise.withResolvers<void>();
        fetchMock.mockImplementation(async (input, options) => {
            if (String(input).endsWith('/source')) {
                return jsonResponse({ value: { error: 'source failed', message: 'primary' } }, 500);
            }
            return await new Promise<Response>((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                    cancelled.resolve();
                    reject(new DOMException('aborted', 'AbortError'));
                }, { once: true });
            });
        });

        await expect(client.captureState('session')).rejects.toMatchObject({
            code: 'source failed',
            message: 'primary',
        });
        await cancelled.promise;
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
        [{ [W3C_ELEMENT_KEY]: 'w3c-id' }, 'w3c-id'],
        [{ ELEMENT: 'legacy-id' }, 'legacy-id'],
    ])('accepts element id response %j', async (value, expectedId) => {
        fetchMock.mockResolvedValue(jsonResponse({ value }));
        await expect(client.findElement('session', 'id', 'login')).resolves.toBe(expectedId);
    });

    it('rejects a find response without an element id', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ value: {} }));

        await expect(client.findElement('session', 'id', 'missing')).rejects.toMatchObject({
            code: 'ELEMENT_NOT_FOUND',
            status: 404,
        });
    });

    it('encodes element ids before issuing element commands', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ value: null }));

        await client.tapElement('session', 'element /?');

        expect(fetchMock).toHaveBeenCalledWith(
            'http://localhost:4723/session/session/element/element%20%2F%3F/click',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('always releases W3C actions after a swipe', async () => {
        fetchMock.mockImplementation(async () => jsonResponse({ value: null }));

        await client.swipe('session', { x: 1, y: 2 }, { x: 3, y: 4 }, 50);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls.map(call => call[1]?.method)).toEqual(['POST', 'DELETE']);
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
            actions: [{ actions: expect.arrayContaining([
                { type: 'pause', duration: 50 },
                { type: 'pointerMove', duration: 50, x: 3, y: 4 },
            ]) }],
        });
    });

    it.each([0, 49, 50.5])('rejects invalid gesture duration %s before contacting Appium', async duration => {
        await expect(client.swipe('session', { x: 1, y: 2 }, { x: 3, y: 4 }, duration)).rejects.toMatchObject({
            code: 'INVALID_GESTURE_DURATION',
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('preserves the action failure when cleanup also fails', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ value: { error: 'action failed', message: 'primary' } }, 500))
            .mockResolvedValueOnce(jsonResponse({ value: { error: 'cleanup failed', message: 'secondary' } }, 500));

        await expect(client.swipe('session', { x: 1, y: 2 }, { x: 3, y: 4 }, 100)).rejects.toMatchObject({
            code: 'action failed',
            message: 'primary',
        });
        expect(fetchMock.mock.calls.map(call => call[1]?.method)).toEqual(['POST', 'DELETE']);
    });

    it('falls back from window rect only for unsupported endpoints', async () => {
        fetchMock.mockImplementation(async input => {
            const url = String(input);
            if (url.endsWith('/window/rect')) {
                return jsonResponse({ value: { error: 'unknown command', message: 'unsupported' } }, 404);
            }
            if (url.endsWith('/window/size')) {
                return jsonResponse({ value: { width: 100, height: 200 } });
            }
            return jsonResponse({ value: null });
        });

        await client.scroll('session', 'down');

        expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
            'http://localhost:4723/session/session/window/rect',
            'http://localhost:4723/session/session/window/size',
            'http://localhost:4723/session/session/actions',
            'http://localhost:4723/session/session/actions',
        ]);
    });

    it('preserves invalid-session 404 errors without probing a fallback endpoint', async () => {
        fetchMock.mockResolvedValue(jsonResponse({
            value: { error: 'invalid session id', message: 'expired' },
        }, 404));

        await expect(client.scroll('session', 'down')).rejects.toMatchObject({
            code: 'invalid session id',
            status: 404,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not hide non-compatibility window errors', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ value: { error: 'unknown error', message: 'broken' } }, 500));

        await expect(client.scroll('session', 'up')).rejects.toMatchObject({
            code: 'unknown error',
            status: 500,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
