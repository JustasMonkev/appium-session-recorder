import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextFunction } from 'express';
import { createSessionMiddleware } from '../../src/server/proxy-middleware';
import { InteractionRecorder } from '../../src/server/interaction-recorder';
import { AppiumCommandClient } from '../../src/core/appium/client';

type MockRequest = {
    method: string;
    path: string;
    params: Record<string, string | string[]>;
    body?: unknown;
};

function createMockRequest(overrides: Partial<MockRequest> = {}): MockRequest {
    return {
        method: 'POST',
        path: '/session/abc123/element',
        params: { sessionId: 'abc123' },
        body: {},
        ...overrides,
    };
}

function createMockResponse() {
    const listeners: Record<string, Array<() => void>> = {};
    const response = {
        statusCode: 200,
        destroyed: false,
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        write: vi.fn().mockReturnValue(true),
        end: vi.fn().mockReturnValue(undefined),
        on: vi.fn((event: string, callback: () => void) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(callback);
        }),
        emitFinish: () => {
            listeners.finish?.forEach(callback => callback());
        },
        emitClose: () => {
            listeners.close?.forEach(callback => callback());
        },
        emitProxySettled: () => {
            listeners['appium-recorder:proxy-settled']?.forEach(callback => callback());
        },
    };

    return response;
}

type FixtureMiddleware = (request: unknown, response: unknown, next: NextFunction) => Promise<void>;

function fixtureMiddleware(value: unknown): FixtureMiddleware {
    if (typeof value !== 'function') throw new TypeError('Expected middleware to be callable');
    return async (request, response, next) => {
        await value(request, response, next);
    };
}

describe('createSessionMiddleware', () => {
    let recorder: InteractionRecorder;
    let captureStateMock = vi.fn<AppiumCommandClient['captureState']>();
    let middleware: FixtureMiddleware;
    let mockNext: NextFunction;

    beforeEach(() => {
        recorder = new InteractionRecorder();
        captureStateMock = vi.fn<AppiumCommandClient['captureState']>()
            .mockResolvedValue({ screenshot: '', source: '' });
        middleware = fixtureMiddleware(createSessionMiddleware(recorder, { captureState: captureStateMock }));
        mockNext = vi.fn();

        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    describe('request filtering', () => {
        it('should reject a non-string session id', async () => {
            const req = createMockRequest({ params: { sessionId: ['first', 'second'] } });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('should skip non-POST requests', async () => {
            const req = createMockRequest({ method: 'GET' });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            expect(mockNext).toHaveBeenCalled();
            expect(recorder.getHistory()).toHaveLength(0);
        });

        it('should record POST requests', async () => {
            const req = createMockRequest({ method: 'POST' });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            expect(mockNext).toHaveBeenCalled();
            expect(recorder.getHistory()).toHaveLength(1);
        });

        it('should skip DELETE requests', async () => {
            const req = createMockRequest({ method: 'DELETE' });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            expect(mockNext).toHaveBeenCalled();
            expect(recorder.getHistory()).toHaveLength(0);
        });
    });

    describe('interaction recording', () => {
        it('records the mount-relative path without retaining the session id', async () => {
            const req = createMockRequest({
                method: 'POST',
                path: '/element',
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            const history = recorder.getHistory();
            expect(history[0].method).toBe('POST');
            expect(history[0].path).toBe('/element');
            expect(JSON.stringify(history)).not.toContain('abc123');
        });

        it('does not retain request bodies after extracting selector metadata', async () => {
            const req = createMockRequest({
                body: { using: 'xpath', value: '//button' },
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            const history = recorder.getHistory();
            expect('body' in history[0]).toBe(false);
            expect(history[0].elementInfo).toEqual({ using: 'xpath', value: '//button' });
        });

        it('extracts selector metadata without enumerating unrelated body properties', async () => {
            const body = new Proxy({ using: 'id', value: 'login' }, {
                ownKeys: () => { throw new Error('body was enumerated'); },
            });

            await expect(middleware(
                createMockRequest({ body }),
                createMockResponse(),
                mockNext,
            )).resolves.toBeUndefined();
            expect(recorder.getHistory()[0].elementInfo).toEqual({ using: 'id', value: 'login' });
        });

        it('does not retain an empty object body', async () => {
            const req = createMockRequest({
                body: {},
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            const history = recorder.getHistory();
            expect('body' in history[0]).toBe(false);
        });

        it('does not add a body field when the request body is undefined', async () => {
            const req = createMockRequest({
                body: undefined,
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            const history = recorder.getHistory();
            expect('body' in history[0]).toBe(false);
        });

        it.each([false, 0, ''])('does not retain falsy JSON body %j', async body => {
            const req = createMockRequest({ body });

            await middleware(req, createMockResponse(), mockNext);

            expect('body' in recorder.getHistory()[0]).toBe(false);
        });
    });

    describe('element info extraction', () => {
        it('should extract element info from find element request', async () => {
            const req = createMockRequest({
                body: { using: 'accessibility id', value: 'loginButton' },
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            const history = recorder.getHistory();
            expect(history[0].elementInfo).toEqual({
                using: 'accessibility id',
                value: 'loginButton',
            });
        });

        it('should extract element info with xpath strategy', async () => {
            const req = createMockRequest({
                body: { using: 'xpath', value: '//XCUIElementTypeButton[@name="Login"]' },
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            const history = recorder.getHistory();
            expect(history[0].elementInfo).toEqual({
                using: 'xpath',
                value: '//XCUIElementTypeButton[@name="Login"]',
            });
        });

        it('should not set elementInfo when using is missing', async () => {
            const req = createMockRequest({
                body: { value: 'loginButton' },
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            const history = recorder.getHistory();
            expect(history[0].elementInfo).toBeUndefined();
        });

        it('should not set elementInfo when value is missing', async () => {
            const req = createMockRequest({
                body: { using: 'accessibility id' },
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            const history = recorder.getHistory();
            expect(history[0].elementInfo).toBeUndefined();
        });

        it.each([
            { using: 1, value: 'loginButton' },
            { using: 'id', value: false },
        ])('should reject non-string selector fields: %j', async body => {
            await middleware(createMockRequest({ body }), createMockResponse(), mockNext);

            expect(recorder.getHistory()[0].elementInfo).toBeUndefined();
        });

        it('reuses the selector that originally resolved an element id', async () => {
            const findReq = createMockRequest({
                path: '/session/abc123/element',
                body: { using: 'accessibility id', value: 'loginButton' },
            });
            const findRes = createMockResponse();

            await middleware(findReq, findRes, mockNext);

            findRes.end(JSON.stringify({
                value: {
                    'element-6066-11e4-a52e-4f735466cecf': 'element-1',
                },
            }));
            findRes.emitFinish();

            const clickReq = createMockRequest({
                path: '/session/abc123/element/element-1/click',
                body: {},
            });
            const clickRes = createMockResponse();

            await middleware(clickReq, clickRes, mockNext);

            const history = recorder.getHistory();
            expect(history[1].elementInfo).toEqual({
                using: 'accessibility id',
                value: 'loginButton',
            });
        });

        it('reuses selectors for percent-encoded opaque element ids', async () => {
            const findRes = createMockResponse();
            await middleware(createMockRequest({
                body: { using: 'id', value: 'reserved' },
            }), findRes, mockNext);
            findRes.end(JSON.stringify({
                value: { 'element-6066-11e4-a52e-4f735466cecf': 'element /?' },
            }));
            findRes.emitFinish();

            await middleware(createMockRequest({
                path: '/session/abc123/element/element%20%2F%3F/click',
            }), createMockResponse(), mockNext);

            expect(recorder.getHistory()[1].elementInfo).toEqual({ using: 'id', value: 'reserved' });
        });

        it('isolates colon-containing session and element ids', async () => {
            const mapSelector = async (sessionId: string, elementId: string, value: string) => {
                const response = createMockResponse();
                await middleware(createMockRequest({
                    params: { sessionId },
                    body: { using: 'id', value },
                }), response, mockNext);
                response.end(JSON.stringify({
                    value: { 'element-6066-11e4-a52e-4f735466cecf': elementId },
                }));
                response.emitFinish();
            };
            await mapSelector('a:b', 'c', 'first');
            await mapSelector('a', 'b:c', 'second');

            await middleware(createMockRequest({
                params: { sessionId: 'a:b' },
                path: '/session/a:b/element/c/click',
            }), createMockResponse(), mockNext);

            expect(recorder.getHistory().at(-1)?.elementInfo).toEqual({ using: 'id', value: 'first' });
        });

        it('does not cache oversized selector fields', async () => {
            const findRes = createMockResponse();
            await middleware(createMockRequest({
                body: { using: 'id', value: 'x'.repeat(64 * 1024 + 1) },
            }), findRes, mockNext);
            findRes.end(JSON.stringify({
                value: { 'element-6066-11e4-a52e-4f735466cecf': 'oversized-selector' },
            }));
            findRes.emitFinish();

            await middleware(createMockRequest({
                path: '/session/abc123/element/oversized-selector/click',
            }), createMockResponse(), mockNext);

            expect(recorder.getHistory().at(-1)?.elementInfo).toBeUndefined();
        });

        it('does not cache oversized element ids', async () => {
            const elementId = 'e'.repeat(64 * 1024 + 1);
            const findRes = createMockResponse();
            await middleware(createMockRequest({ body: { using: 'id', value: 'normal' } }), findRes, mockNext);
            findRes.end(JSON.stringify({
                value: { 'element-6066-11e4-a52e-4f735466cecf': elementId },
            }));
            findRes.emitFinish();

            await middleware(createMockRequest({
                path: `/session/abc123/element/${elementId}/click`,
            }), createMockResponse(), mockNext);

            expect(recorder.getHistory().at(-1)?.elementInfo).toBeUndefined();
        });

        it('evicts old selector mappings when their aggregate bytes exceed the cache budget', async () => {
            for (let index = 0; index < 40; index++) {
                const response = createMockResponse();
                await middleware(createMockRequest({
                    body: { using: 'id', value: `${index}:${'x'.repeat(60 * 1024)}` },
                }), response, mockNext);
                response.end(JSON.stringify({
                    value: { 'element-6066-11e4-a52e-4f735466cecf': `element-${index}` },
                }));
                response.emitFinish();
            }

            await middleware(createMockRequest({
                path: '/session/abc123/element/element-0/click',
            }), createMockResponse(), mockNext);

            expect(recorder.getHistory().at(-1)?.elementInfo).toBeUndefined();
        });

        it('should discard selector mappings from responses larger than 1 MiB', async () => {
            const findRes = createMockResponse();
            await middleware(createMockRequest({
                body: { using: 'id', value: 'loginButton' },
            }), findRes, mockNext);
            findRes.end(JSON.stringify({
                padding: 'x'.repeat(1024 * 1024),
                value: { 'element-6066-11e4-a52e-4f735466cecf': 'oversized-element' },
            }));
            findRes.emitFinish();

            await middleware(createMockRequest({
                path: '/session/abc123/element/oversized-element/click',
            }), createMockResponse(), mockNext);

            expect(recorder.getHistory()[1].elementInfo).toBeUndefined();
        });

        it('should clear resolved selectors when the session is deleted', async () => {
            const findRes = createMockResponse();
            await middleware(createMockRequest({
                body: { using: 'id', value: 'loginButton' },
            }), findRes, mockNext);
            findRes.end(JSON.stringify({
                value: { 'element-6066-11e4-a52e-4f735466cecf': 'element-to-delete' },
            }));
            findRes.emitFinish();

            await middleware(createMockRequest({ method: 'DELETE', path: '/' }), createMockResponse(), mockNext);
            await middleware(createMockRequest({
                path: '/session/abc123/element/element-to-delete/click',
            }), createMockResponse(), mockNext);

            expect(recorder.getHistory()[1].elementInfo).toBeUndefined();
        });

        it('clears resolved selectors when recorded history is cleared', async () => {
            const findRes = createMockResponse();
            await middleware(createMockRequest({ body: { using: 'id', value: 'loginButton' } }), findRes, mockNext);
            findRes.end(JSON.stringify({
                value: { 'element-6066-11e4-a52e-4f735466cecf': 'element-after-clear' },
            }));
            findRes.emitFinish();
            recorder.clearHistory();

            await middleware(createMockRequest({
                path: '/session/abc123/element/element-after-clear/click',
            }), createMockResponse(), mockNext);

            expect(recorder.getHistory()[0].elementInfo).toBeUndefined();
        });

        it.each([302, 500])('should not map selectors or capture state after upstream status %s', async status => {
            const findRes = createMockResponse();
            await middleware(createMockRequest({
                body: { using: 'id', value: 'loginButton' },
            }), findRes, mockNext);
            findRes.statusCode = status;
            findRes.end(JSON.stringify({ value: { 'element-6066-11e4-a52e-4f735466cecf': 'failed-element' } }));
            findRes.emitFinish();

            expect(captureStateMock).not.toHaveBeenCalled();

            await middleware(createMockRequest({
                path: '/session/abc123/element/failed-element/click',
            }), createMockResponse(), mockNext);
            expect(recorder.getHistory()[1].elementInfo).toBeUndefined();
        });
    });

    describe('action endpoints and state capture', () => {
        it.each([302, 500])('marks an unsuccessful action response as skipped (%s)', async status => {
            const response = createMockResponse();
            await middleware(createMockRequest({
                path: '/session/abc123/element/xyz/click',
            }), response, mockNext);
            response.statusCode = status;

            response.emitFinish();

            expect(recorder.getHistory()[0].captureStatus).toBe('skipped');
            expect(captureStateMock).not.toHaveBeenCalled();
        });

        it('should block the next session request before the prior action response finishes', async () => {
            const firstResponse = createMockResponse();
            await middleware(createMockRequest({
                path: '/session/abc123/element/xyz/click',
            }), firstResponse, mockNext);

            const secondRequest = middleware(createMockRequest({
                path: '/session/abc123/screenshot',
            }), createMockResponse(), mockNext);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(mockNext).toHaveBeenCalledTimes(1);

            firstResponse.emitFinish();
            await secondRequest;
            expect(mockNext).toHaveBeenCalledTimes(2);
        });

        it('holds the session until a disconnected action settles upstream', async () => {
            const firstResponse = createMockResponse();
            await middleware(createMockRequest({
                path: '/session/abc123/element/first/click',
            }), firstResponse, mockNext);

            const nextRequest = middleware(createMockRequest({
                path: '/session/abc123/screenshot',
            }), createMockResponse(), mockNext);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(mockNext).toHaveBeenCalledTimes(1);

            firstResponse.emitClose();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(mockNext).toHaveBeenCalledTimes(1);

            firstResponse.emitProxySettled();
            await nextRequest;
            expect(mockNext).toHaveBeenCalledTimes(2);
            expect(captureStateMock).not.toHaveBeenCalled();
            expect(recorder.getHistory()[0].captureStatus).toBe('failed');
        });

        it('serializes three overlapping actions through capture completion', async () => {
            const captures = Array.from({ length: 3 }, () => Promise.withResolvers<{
                screenshot: string;
                source: string;
            }>());
            captureStateMock
                .mockReturnValueOnce(captures[0].promise)
                .mockReturnValueOnce(captures[1].promise)
                .mockReturnValueOnce(captures[2].promise);
            const forwarded: string[] = [];
            const responses = [createMockResponse(), createMockResponse(), createMockResponse()];
            const invoke = (index: number) => {
                const next: NextFunction = () => {
                    forwarded.push(String(index));
                };
                return middleware(createMockRequest({
                    path: `/session/abc123/element/${index}/click`,
                }), responses[index], next);
            };

            await invoke(0);
            const second = invoke(1);
            const third = invoke(2);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(forwarded).toEqual(['0']);

            responses[0].emitFinish();
            await vi.waitFor(() => expect(captureStateMock).toHaveBeenCalledTimes(1));
            captures[0].resolve({ screenshot: '', source: '<First />' });
            await second;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(forwarded).toEqual(['0', '1']);

            responses[1].emitFinish();
            await vi.waitFor(() => expect(captureStateMock).toHaveBeenCalledTimes(2));
            captures[1].resolve({ screenshot: '', source: '<Second />' });
            await third;
            expect(forwarded).toEqual(['0', '1', '2']);

            responses[2].emitFinish();
            captures[2].resolve({ screenshot: '', source: '<Third />' });
            await vi.waitFor(() => expect(recorder.getHistory().at(-1)?.source).toBe('<Third />'));
        });

        it('bounds capture concurrency and drops work beyond the global queue', async () => {
            const release = Promise.withResolvers<void>();
            let active = 0;
            let peak = 0;
            captureStateMock.mockImplementation(async () => {
                active++;
                peak = Math.max(peak, active);
                await release.promise;
                active--;
                return { screenshot: '', source: '<Captured />' };
            });
            vi.spyOn(console, 'error').mockImplementation(() => undefined);

            const responses = Array.from({ length: 24 }, () => createMockResponse());
            for (let index = 0; index < responses.length; index++) {
                const sessionId = `session-${index}`;
                await middleware(createMockRequest({
                    params: { sessionId },
                    path: `/session/${sessionId}/element/button/click`,
                }), responses[index], mockNext);
                responses[index].emitFinish();
            }

            await vi.waitFor(() => expect(captureStateMock).toHaveBeenCalledTimes(2));
            expect(peak).toBe(2);

            const afterDropped = vi.fn();
            await middleware(createMockRequest({
                params: { sessionId: 'session-23' },
                path: '/session/session-23/screenshot',
            }), createMockResponse(), afterDropped);
            expect(afterDropped).toHaveBeenCalledOnce();

            release.resolve();
            await vi.waitFor(() => expect(captureStateMock).toHaveBeenCalledTimes(18));
            expect(peak).toBeLessThanOrEqual(2);
            expect(recorder.getHistory().filter(interaction => interaction.captureStatus === 'skipped')).toHaveLength(6);
        });

        it('waits for an action response to finish before capturing state', async () => {
            const req = createMockRequest({
                method: 'POST',
                path: '/session/abc123/element/xyz/click',
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            expect(recorder.getHistory()[0].captureStatus).toBe('pending');
            expect(captureStateMock).not.toHaveBeenCalled();
            res.emitFinish();
            await vi.waitFor(() => expect(captureStateMock).toHaveBeenCalledWith('abc123'));
        });

        it('does not capture state for a non-action response', async () => {
            const req = createMockRequest({
                method: 'POST',
                path: '/session/abc123/screenshot',
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            res.emitFinish();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(recorder.getHistory()[0].captureStatus).toBeUndefined();
            expect(captureStateMock).not.toHaveBeenCalled();
        });

        it('should capture state on response finish for action endpoints', async () => {
            const req = createMockRequest({
                method: 'POST',
                path: '/session/abc123/element/xyz/click',
            });
            const res = createMockResponse();

            const screenshotBase64 = Buffer.from('png-bytes').toString('base64');

            captureStateMock.mockResolvedValue({
                screenshot: screenshotBase64,
                source: '<xml>source</xml>',
            });
            const captured = Promise.withResolvers<void>();
            const unsubscribe = recorder.on(event => {
                if (event.type === 'interaction' && event.data.source) {
                    unsubscribe();
                    captured.resolve();
                }
            });

            await middleware(req, res, mockNext);

            res.emitFinish();
            await captured.promise;

            expect(captureStateMock).toHaveBeenCalledWith('abc123');

            const history = recorder.getHistory();
            expect(history[0].screenshotUrl).toMatch(
                new RegExp(`^/_recorder/api/screenshot/${history[0].id}\\?v=\\d+$`),
            );
            expect(history[0].source).toBe('<xml>source</xml>');
            expect(recorder.getScreenshot(history[0].id)).toEqual(Buffer.from('png-bytes'));
        });

        it('should leave recorded state empty when capture fails', async () => {
            const req = createMockRequest({
                method: 'POST',
                path: '/session/abc123/element/xyz/click',
            });
            const res = createMockResponse();

            const secret = 'captured-page-secret';
            captureStateMock.mockRejectedValue(Object.assign(new Error(secret), {
                details: { source: secret },
            }));
            const logged = Promise.withResolvers<void>();
            const errorLog = vi.spyOn(console, 'error').mockImplementation(() => logged.resolve());

            await middleware(req, res, mockNext);

            res.emitFinish();
            await logged.promise;

            const history = recorder.getHistory();
            expect(history[0].screenshotUrl).toBeUndefined();
            expect(history[0].source).toBeUndefined();
            expect(history[0].captureStatus).toBe('failed');
            expect(errorLog).toHaveBeenCalledWith(`[${history[0].id}] Failed to capture state`);
            expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
        });
    });

    describe('next() behavior', () => {
        it('should always call next()', async () => {
            const req = createMockRequest();
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            expect(mockNext).toHaveBeenCalledTimes(1);
        });

        it('should call next() even for skipped requests', async () => {
            const req = createMockRequest({ method: 'GET' });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            expect(mockNext).toHaveBeenCalledTimes(1);
        });
    });

    describe('various action endpoints', () => {
        const actionEndpoints = [
            ['/session/abc123/element/xyz/click', 'tap'],
            ['/session/abc123/element/xyz/value', 'type'],
            ['/session/abc123/element/xyz/clear', 'clear'],
            ['/session/abc123/element', 'find'],
            ['/session/abc123/elements', 'find'],
            ['/session/abc123/touch/perform', 'swipe'],
            ['/session/abc123/actions', 'swipe'],
            ['/session/abc123/back', 'back'],
            ['/session/abc123/forward', 'forward'],
            ['/session/abc123/refresh', 'refresh'],
        ];

        actionEndpoints.forEach(([endpoint, actionKind]) => {
            it(`should recognize ${endpoint} as action endpoint`, async () => {
                const req = createMockRequest({
                    method: 'POST',
                    path: endpoint,
                });
                const res = createMockResponse();

                await middleware(req, res, mockNext);

                expect(recorder.getHistory()[0]).toMatchObject({ actionKind, captureStatus: 'pending' });
            });
        });
    });

    describe('non-action endpoints', () => {
        const nonActionEndpoints = [
            '/session/abc123/screenshot',
            '/session/abc123/source',
            '/session/abc123/window',
            '/session/abc123/url',
            '/session/abc123/title',
        ];

        nonActionEndpoints.forEach(endpoint => {
            it(`should not recognize ${endpoint} as action endpoint`, async () => {
                const req = createMockRequest({
                    method: 'POST',
                    path: endpoint,
                });
                const res = createMockResponse();

                await middleware(req, res, mockNext);

                res.emitFinish();
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(recorder.getHistory()[0]).toMatchObject({ actionKind: 'unknown' });
                expect(recorder.getHistory()[0].captureStatus).toBeUndefined();
                expect(captureStateMock).not.toHaveBeenCalled();
            });
        });
    });
});
