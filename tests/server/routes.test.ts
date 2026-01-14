import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { createRoutes } from '../../src/server/routes';
import { InteractionRecorder } from '../../src/server/interaction-recorder';

// Mock request
function createMockRequest(overrides: Partial<Request> = {}): Request {
    const listeners: Record<string, Function[]> = {};
    return {
        on: vi.fn((event: string, callback: Function) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(callback);
            return this;
        }),
        emit: (event: string) => {
            listeners[event]?.forEach(cb => cb());
        },
        ...overrides,
    } as unknown as Request;
}

// Mock response
function createMockResponse(): Response & { _written: string[]; _json: any } {
    const res = {
        _written: [] as string[],
        _json: null as any,
        json: vi.fn(function(data: any) {
            res._json = data;
            return res;
        }),
        setHeader: vi.fn().mockReturnThis(),
        write: vi.fn(function(data: string) {
            res._written.push(data);
            return res;
        }),
        sendFile: vi.fn().mockReturnThis(),
    };
    return res as unknown as Response & { _written: string[]; _json: any };
}

describe('createRoutes', () => {
    let recorder: InteractionRecorder;
    let router: ReturnType<typeof createRoutes>;

    beforeEach(() => {
        recorder = new InteractionRecorder();
        router = createRoutes(recorder);
    });

    // Helper to find route handler
    function getRouteHandler(method: string, path: string) {
        const stack = (router as any).stack;
        for (const layer of stack) {
            if (layer.route) {
                const routePath = layer.route.path;
                const routeMethods = Object.keys(layer.route.methods);
                if (routePath === path && routeMethods.includes(method.toLowerCase())) {
                    return layer.route.stack[0].handle;
                }
            }
        }
        return null;
    }

    describe('GET /_recorder/api/history', () => {
        it('should return empty array when no history', () => {
            const handler = getRouteHandler('GET', '/_recorder/api/history');
            expect(handler).not.toBeNull();

            const req = createMockRequest();
            const res = createMockResponse();

            handler(req, res);

            expect(res.json).toHaveBeenCalledWith([]);
        });

        it('should return recorded interactions', () => {
            recorder.recordInteraction({ method: 'POST', path: '/test1' });
            recorder.recordInteraction({ method: 'POST', path: '/test2' });

            const handler = getRouteHandler('GET', '/_recorder/api/history');
            const req = createMockRequest();
            const res = createMockResponse();

            handler(req, res);

            expect(res._json).toHaveLength(2);
            expect(res._json[0].path).toBe('/test1');
            expect(res._json[1].path).toBe('/test2');
        });
    });

    describe('DELETE /_recorder/api/history', () => {
        it('should clear history', () => {
            recorder.recordInteraction({ method: 'POST', path: '/test' });
            expect(recorder.getHistory()).toHaveLength(1);

            const handler = getRouteHandler('DELETE', '/_recorder/api/history');
            const req = createMockRequest();
            const res = createMockResponse();

            handler(req, res);

            expect(recorder.getHistory()).toHaveLength(0);
            expect(res.json).toHaveBeenCalledWith({ ok: true });
        });
    });

    describe('GET /_recorder/api/stream (SSE)', () => {
        it('should set correct headers for SSE', () => {
            const handler = getRouteHandler('GET', '/_recorder/api/stream');
            const req = createMockRequest();
            const res = createMockResponse();

            handler(req, res);

            expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
            expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
            expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
        });

        it('should send initial history on connection', () => {
            recorder.recordInteraction({ method: 'POST', path: '/existing' });

            const handler = getRouteHandler('GET', '/_recorder/api/stream');
            const req = createMockRequest();
            const res = createMockResponse();

            handler(req, res);

            expect(res._written.length).toBeGreaterThan(0);
            const initData = JSON.parse(res._written[0].replace('data: ', '').replace('\n\n', ''));
            expect(initData.type).toBe('init');
            expect(initData.data).toHaveLength(1);
        });

        it('should stream new interactions', () => {
            const handler = getRouteHandler('GET', '/_recorder/api/stream');
            const req = createMockRequest();
            const res = createMockResponse();

            handler(req, res);

            const initialWriteCount = res._written.length;

            // Record new interaction
            recorder.recordInteraction({ method: 'POST', path: '/new' });

            expect(res._written.length).toBe(initialWriteCount + 1);
            const eventData = JSON.parse(res._written[res._written.length - 1].replace('data: ', '').replace('\n\n', ''));
            expect(eventData.type).toBe('interaction');
            expect(eventData.data.path).toBe('/new');
        });

        it('should stream interaction updates', () => {
            const handler = getRouteHandler('GET', '/_recorder/api/stream');
            const req = createMockRequest();
            const res = createMockResponse();

            handler(req, res);

            const interaction = recorder.recordInteraction({ method: 'POST', path: '/test' });
            const afterRecordCount = res._written.length;

            recorder.updateInteraction(interaction.id, { screenshot: 'base64data' });

            expect(res._written.length).toBe(afterRecordCount + 1);
            const eventData = JSON.parse(res._written[res._written.length - 1].replace('data: ', '').replace('\n\n', ''));
            expect(eventData.data.screenshot).toBe('base64data');
        });

        it('should stream clear events', () => {
            const handler = getRouteHandler('GET', '/_recorder/api/stream');
            const req = createMockRequest();
            const res = createMockResponse();

            handler(req, res);

            recorder.recordInteraction({ method: 'POST', path: '/test' });
            const beforeClearCount = res._written.length;

            recorder.clearHistory();

            expect(res._written.length).toBe(beforeClearCount + 1);
            const eventData = JSON.parse(res._written[res._written.length - 1].replace('data: ', '').replace('\n\n', ''));
            expect(eventData.type).toBe('clear');
            expect(eventData.data).toBeNull();
        });

        it('should unsubscribe on client disconnect', () => {
            const handler = getRouteHandler('GET', '/_recorder/api/stream');
            const req = createMockRequest();
            const res = createMockResponse();

            handler(req, res);

            // Simulate client disconnect
            (req as any).emit('close');

            // Record interaction after disconnect
            const currentCount = res._written.length;
            recorder.recordInteraction({ method: 'POST', path: '/after-disconnect' });

            // Should not receive new events
            expect(res._written.length).toBe(currentCount);
        });
    });

    describe('GET /_recorder', () => {
        it('should have route for serving UI', () => {
            const handler = getRouteHandler('GET', '/_recorder');
            expect(handler).not.toBeNull();
        });

        it('should call sendFile with UI path', () => {
            const handler = getRouteHandler('GET', '/_recorder');
            const req = createMockRequest();
            const res = createMockResponse();

            handler(req, res);

            expect(res.sendFile).toHaveBeenCalled();
            const sentPath = (res.sendFile as any).mock.calls[0][0];
            expect(sentPath).toContain('dist/ui/index.html');
        });
    });

    describe('SSE data format', () => {
        it('should format SSE data correctly with proper line endings', () => {
            const handler = getRouteHandler('GET', '/_recorder/api/stream');
            const req = createMockRequest();
            const res = createMockResponse();

            handler(req, res);

            // Check format of init message
            const initMessage = res._written[0];
            expect(initMessage).toMatch(/^data: .+\n\n$/);
        });

        it('should send valid JSON in SSE data field', () => {
            recorder.recordInteraction({ method: 'POST', path: '/test', body: { key: 'value' } });

            const handler = getRouteHandler('GET', '/_recorder/api/stream');
            const req = createMockRequest();
            const res = createMockResponse();

            handler(req, res);

            // Verify all written data can be parsed as JSON
            res._written.forEach(msg => {
                const jsonStr = msg.replace('data: ', '').replace('\n\n', '');
                expect(() => JSON.parse(jsonStr)).not.toThrow();
            });
        });
    });

    describe('multiple SSE clients', () => {
        it('should support multiple simultaneous SSE connections', () => {
            const handler = getRouteHandler('GET', '/_recorder/api/stream');

            const req1 = createMockRequest();
            const res1 = createMockResponse();
            handler(req1, res1);

            const req2 = createMockRequest();
            const res2 = createMockResponse();
            handler(req2, res2);

            // Record interaction
            recorder.recordInteraction({ method: 'POST', path: '/test' });

            // Both clients should receive the event
            // Each client receives: init + interaction = at least 2 writes
            expect(res1._written.length).toBeGreaterThanOrEqual(2);
            expect(res2._written.length).toBeGreaterThanOrEqual(2);
        });

        it('should only unsubscribe disconnected client', () => {
            const handler = getRouteHandler('GET', '/_recorder/api/stream');

            const req1 = createMockRequest();
            const res1 = createMockResponse();
            handler(req1, res1);

            const req2 = createMockRequest();
            const res2 = createMockResponse();
            handler(req2, res2);

            // Disconnect first client
            (req1 as any).emit('close');

            const res1CountBeforeNew = res1._written.length;
            const res2CountBeforeNew = res2._written.length;

            // Record new interaction
            recorder.recordInteraction({ method: 'POST', path: '/after-disconnect' });

            // First client should not receive, second should
            expect(res1._written.length).toBe(res1CountBeforeNew);
            expect(res2._written.length).toBe(res2CountBeforeNew + 1);
        });
    });
});
