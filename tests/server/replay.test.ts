import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRoutes } from '../../src/server/routes';
import { InteractionRecorder } from '../../src/server/interaction-recorder';
import { AppiumCommandClient } from '../../src/core/appium/client';
import type { Request, Response } from 'express';

function createMockRequest(overrides: Partial<Request> = {}): Request {
    const listeners: Record<string, Function[]> = {};
    return {
        params: {},
        body: {},
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

function createMockResponse(): Response & { _json: any; _status: number } {
    const res = {
        _json: null as any,
        _status: 200,
        status: vi.fn(function(code: number) {
            res._status = code;
            return res;
        }),
        json: vi.fn(function(data: any) {
            res._json = data;
            return res;
        }),
        setHeader: vi.fn().mockReturnThis(),
        write: vi.fn().mockReturnThis(),
        sendFile: vi.fn().mockReturnThis(),
    };
    return res as unknown as Response & { _json: any; _status: number };
}

describe('POST /_recorder/api/interactions/:id/replay', () => {
    let recorder: InteractionRecorder;
    let commandClient: AppiumCommandClient;
    let router: ReturnType<typeof createRoutes>;

    beforeEach(() => {
        recorder = new InteractionRecorder();
        commandClient = new AppiumCommandClient('http://localhost:4723');
        router = createRoutes(recorder, commandClient);
    });

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

    it('should return 404 when interaction is not found', async () => {
        const handler = getRouteHandler('POST', '/_recorder/api/interactions/:id/replay');
        expect(handler).not.toBeNull();

        const req = createMockRequest({ params: { id: '999' } });
        const res = createMockResponse();

        await handler(req, res);

        expect(res._status).toBe(404);
        expect(res._json.ok).toBe(false);
    });

    it('should return 400 for non-replayable action kinds', async () => {
        const interaction = recorder.recordInteraction({
            method: 'POST',
            path: '/session/abc/element',
            actionKind: 'find',
            sessionId: 'abc',
        });

        const handler = getRouteHandler('POST', '/_recorder/api/interactions/:id/replay');
        const req = createMockRequest({ params: { id: String(interaction.id) } });
        const res = createMockResponse();

        await handler(req, res);

        expect(res._status).toBe(400);
        expect(res._json.ok).toBe(false);
        expect(res._json.error).toContain('not replayable');
    });

    it('should return 400 when no sessionId is available', async () => {
        const interaction = recorder.recordInteraction({
            method: 'POST',
            path: '/session/abc/element/xyz/click',
            actionKind: 'tap',
            // no sessionId
        });

        const handler = getRouteHandler('POST', '/_recorder/api/interactions/:id/replay');
        const req = createMockRequest({ params: { id: String(interaction.id) }, body: {} });
        const res = createMockResponse();

        await handler(req, res);

        expect(res._status).toBe(400);
        expect(res._json.ok).toBe(false);
        expect(res._json.error).toContain('sessionId');
    });

    it('should return 400 when tap has no selector', async () => {
        const interaction = recorder.recordInteraction({
            method: 'POST',
            path: '/session/abc/element/xyz/click',
            actionKind: 'tap',
            sessionId: 'abc',
            // no elementInfo
        });

        const handler = getRouteHandler('POST', '/_recorder/api/interactions/:id/replay');
        const req = createMockRequest({ params: { id: String(interaction.id) }, body: {} });
        const res = createMockResponse();

        await handler(req, res);

        expect(res._status).toBe(400);
        expect(res._json.error).toContain('selector');
    });

    it('should replay tap action successfully', async () => {
        const interaction = recorder.recordInteraction({
            method: 'POST',
            path: '/session/abc/element/xyz/click',
            actionKind: 'tap',
            sessionId: 'abc',
            elementInfo: { using: 'accessibility id', value: 'loginBtn' },
        });

        vi.spyOn(commandClient, 'tap').mockResolvedValue(undefined);

        const handler = getRouteHandler('POST', '/_recorder/api/interactions/:id/replay');
        const req = createMockRequest({ params: { id: String(interaction.id) }, body: {} });
        const res = createMockResponse();

        await handler(req, res);

        expect(res._json.ok).toBe(true);
        expect(res._json.actionKind).toBe('tap');
        expect(commandClient.tap).toHaveBeenCalledWith('abc', 'accessibility id', 'loginBtn');
    });

    it('should replay back action without selector', async () => {
        const interaction = recorder.recordInteraction({
            method: 'POST',
            path: '/session/abc/back',
            actionKind: 'back',
            sessionId: 'abc',
        });

        vi.spyOn(commandClient, 'back').mockResolvedValue(undefined);

        const handler = getRouteHandler('POST', '/_recorder/api/interactions/:id/replay');
        const req = createMockRequest({ params: { id: String(interaction.id) }, body: {} });
        const res = createMockResponse();

        await handler(req, res);

        expect(res._json.ok).toBe(true);
        expect(commandClient.back).toHaveBeenCalledWith('abc');
    });

    it('should replay clear action successfully', async () => {
        const interaction = recorder.recordInteraction({
            method: 'POST',
            path: '/session/abc/element/xyz/clear',
            actionKind: 'clear',
            sessionId: 'abc',
            elementInfo: { using: 'accessibility id', value: 'inputField' },
        });

        vi.spyOn(commandClient, 'clear').mockResolvedValue(undefined);

        const handler = getRouteHandler('POST', '/_recorder/api/interactions/:id/replay');
        const req = createMockRequest({ params: { id: String(interaction.id) }, body: {} });
        const res = createMockResponse();

        await handler(req, res);

        expect(res._json.ok).toBe(true);
        expect(commandClient.clear).toHaveBeenCalledWith('abc', 'accessibility id', 'inputField');
    });

    it('should replay scroll action with default direction', async () => {
        const interaction = recorder.recordInteraction({
            method: 'POST',
            path: '/session/abc/actions',
            actionKind: 'scroll',
            sessionId: 'abc',
        });

        vi.spyOn(commandClient, 'scroll').mockResolvedValue(undefined);

        const handler = getRouteHandler('POST', '/_recorder/api/interactions/:id/replay');
        const req = createMockRequest({ params: { id: String(interaction.id) }, body: {} });
        const res = createMockResponse();

        await handler(req, res);

        expect(res._json.ok).toBe(true);
        expect(commandClient.scroll).toHaveBeenCalledWith('abc', 'down', 300);
    });

    it('should replay type action with text from body', async () => {
        const interaction = recorder.recordInteraction({
            method: 'POST',
            path: '/session/abc/element/xyz/value',
            actionKind: 'type',
            sessionId: 'abc',
            elementInfo: { using: 'accessibility id', value: 'inputField' },
            body: { text: 'hello world' },
        });

        vi.spyOn(commandClient, 'type').mockResolvedValue(undefined);

        const handler = getRouteHandler('POST', '/_recorder/api/interactions/:id/replay');
        const req = createMockRequest({ params: { id: String(interaction.id) }, body: {} });
        const res = createMockResponse();

        await handler(req, res);

        expect(res._json.ok).toBe(true);
        expect(commandClient.type).toHaveBeenCalledWith('abc', 'accessibility id', 'inputField', 'hello world', false);
    });

    it('should allow sessionId override via request body', async () => {
        const interaction = recorder.recordInteraction({
            method: 'POST',
            path: '/session/abc/back',
            actionKind: 'back',
            // no sessionId stored
        });

        vi.spyOn(commandClient, 'back').mockResolvedValue(undefined);

        const handler = getRouteHandler('POST', '/_recorder/api/interactions/:id/replay');
        const req = createMockRequest({
            params: { id: String(interaction.id) },
            body: { sessionId: 'override-session' },
        });
        const res = createMockResponse();

        await handler(req, res);

        expect(res._json.ok).toBe(true);
        expect(commandClient.back).toHaveBeenCalledWith('override-session');
    });

    it('should return 500 when appium command fails', async () => {
        const interaction = recorder.recordInteraction({
            method: 'POST',
            path: '/session/abc/back',
            actionKind: 'back',
            sessionId: 'abc',
        });

        vi.spyOn(commandClient, 'back').mockRejectedValue(new Error('Connection refused'));

        const handler = getRouteHandler('POST', '/_recorder/api/interactions/:id/replay');
        const req = createMockRequest({ params: { id: String(interaction.id) }, body: {} });
        const res = createMockResponse();

        await handler(req, res);

        expect(res._status).toBe(500);
        expect(res._json.ok).toBe(false);
        expect(res._json.error).toContain('Connection refused');
    });

    it('should return 400 when interaction has no actionKind', async () => {
        const interaction = recorder.recordInteraction({
            method: 'POST',
            path: '/session/abc/something',
            sessionId: 'abc',
        });

        const handler = getRouteHandler('POST', '/_recorder/api/interactions/:id/replay');
        const req = createMockRequest({ params: { id: String(interaction.id) }, body: {} });
        const res = createMockResponse();

        await handler(req, res);

        expect(res._status).toBe(400);
        expect(res._json.ok).toBe(false);
    });
});
