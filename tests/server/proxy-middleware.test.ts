import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createSessionMiddleware } from '../../src/server/proxy-middleware';
import { InteractionRecorder } from '../../src/server/interaction-recorder';
import { AppiumClient } from '../../src/server/appium-client';

// Mock Express request
function createMockRequest(overrides: Partial<Request> = {}): Request {
    return {
        method: 'POST',
        originalUrl: '/session/abc123/element',
        path: '/session/abc123/element',
        params: { sessionId: 'abc123' },
        body: {},
        ...overrides,
    } as Request;
}

// Mock Express response
function createMockResponse(): Response {
    const listeners: Record<string, Function[]> = {};
    return {
        on: vi.fn((event: string, callback: Function) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(callback);
        }),
        // Helper to trigger events
        emit: (event: string) => {
            listeners[event]?.forEach(cb => cb());
        },
    } as unknown as Response;
}

describe('createSessionMiddleware', () => {
    let recorder: InteractionRecorder;
    let appiumClient: AppiumClient;
    let middleware: ReturnType<typeof createSessionMiddleware>;
    let mockNext: NextFunction;

    beforeEach(() => {
        recorder = new InteractionRecorder();
        appiumClient = new AppiumClient('http://localhost:4723');
        middleware = createSessionMiddleware(recorder, appiumClient);
        mockNext = vi.fn();

        // Mock console.log to prevent output during tests
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    describe('request filtering', () => {
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

        it('should skip DELETE requests (not recorded by shouldRecord)', async () => {
            const req = createMockRequest({ method: 'DELETE' });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            expect(mockNext).toHaveBeenCalled();
            expect(recorder.getHistory()).toHaveLength(0);
        });
    });

    describe('interaction recording', () => {
        it('should record interaction with method and path', async () => {
            const req = createMockRequest({
                method: 'POST',
                originalUrl: '/session/abc123/element',
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            const history = recorder.getHistory();
            expect(history[0].method).toBe('POST');
            expect(history[0].path).toBe('/session/abc123/element');
        });

        it('should record body when present', async () => {
            const req = createMockRequest({
                body: { using: 'xpath', value: '//button' },
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            const history = recorder.getHistory();
            expect(history[0].body).toEqual({ using: 'xpath', value: '//button' });
        });

        it('should not record body when empty', async () => {
            const req = createMockRequest({
                body: {},
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            const history = recorder.getHistory();
            expect(history[0].body).toBeUndefined();
        });

        it('should not record body when undefined', async () => {
            const req = createMockRequest({
                body: undefined,
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            const history = recorder.getHistory();
            expect(history[0].body).toBeUndefined();
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
    });

    describe('action endpoints and state capture', () => {
        it('should register finish listener for action endpoints', async () => {
            const req = createMockRequest({
                method: 'POST',
                path: '/session/abc123/element/xyz/click',
                originalUrl: '/session/abc123/element/xyz/click',
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
        });

        it('should not register finish listener for non-action endpoints', async () => {
            const req = createMockRequest({
                method: 'POST',
                path: '/session/abc123/screenshot',
                originalUrl: '/session/abc123/screenshot',
            });
            const res = createMockResponse();

            await middleware(req, res, mockNext);

            expect(res.on).not.toHaveBeenCalled();
        });

        it('should capture state on response finish for action endpoints', async () => {
            const req = createMockRequest({
                method: 'POST',
                path: '/session/abc123/element/xyz/click',
                originalUrl: '/session/abc123/element/xyz/click',
            });
            const res = createMockResponse();

            // Mock captureState
            vi.spyOn(appiumClient, 'captureState').mockResolvedValue({
                screenshot: 'base64Screenshot',
                source: '<xml>source</xml>',
            });

            await middleware(req, res, mockNext);

            // Trigger finish event
            (res as any).emit('finish');

            // Wait for async operation
            await new Promise(resolve => setTimeout(resolve, 10));

            expect(appiumClient.captureState).toHaveBeenCalledWith('abc123');

            const history = recorder.getHistory();
            expect(history[0].screenshot).toBe('base64Screenshot');
            expect(history[0].source).toBe('<xml>source</xml>');
        });

        it('should handle captureState returning partial data', async () => {
            const req = createMockRequest({
                method: 'POST',
                path: '/session/abc123/element/xyz/click',
                originalUrl: '/session/abc123/element/xyz/click',
            });
            const res = createMockResponse();

            vi.spyOn(appiumClient, 'captureState').mockResolvedValue({
                screenshot: 'base64Screenshot',
            });

            await middleware(req, res, mockNext);

            (res as any).emit('finish');
            await new Promise(resolve => setTimeout(resolve, 10));

            const history = recorder.getHistory();
            expect(history[0].screenshot).toBe('base64Screenshot');
            expect(history[0].source).toBeUndefined();
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
            '/session/abc123/element/xyz/click',
            '/session/abc123/element/xyz/value',
            '/session/abc123/element/xyz/clear',
            '/session/abc123/element',
            '/session/abc123/elements',
            '/session/abc123/touch/perform',
            '/session/abc123/actions',
            '/session/abc123/back',
            '/session/abc123/forward',
            '/session/abc123/refresh',
        ];

        actionEndpoints.forEach(endpoint => {
            it(`should recognize ${endpoint} as action endpoint`, async () => {
                const req = createMockRequest({
                    method: 'POST',
                    path: endpoint,
                    originalUrl: endpoint,
                });
                const res = createMockResponse();

                await middleware(req, res, mockNext);

                expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
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
                    originalUrl: endpoint,
                });
                const res = createMockResponse();

                await middleware(req, res, mockNext);

                expect(res.on).not.toHaveBeenCalled();
            });
        });
    });
});
