import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runDriveBack, runDriveScroll, runDriveSwipe, runDriveTap, runDriveType } from '../../src/cli/commands/drive';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('drive commands', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('taps element by selector', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ value: { 'element-6066-11e4-a52e-4f735466cecf': 'element-1' } }))
            .mockResolvedValueOnce(jsonResponse({ value: null }));

        const result = await runDriveTap([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'session-1',
            '--using', 'accessibility id',
            '--value', 'Login',
        ]);

        expect(result.command).toBe('drive.tap');
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            'http://127.0.0.1:4723/session/session-1/element/element-1/click',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('types text with clear-first', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ value: { 'element-6066-11e4-a52e-4f735466cecf': 'element-1' } }))
            .mockResolvedValueOnce(jsonResponse({ value: null }))
            .mockResolvedValueOnce(jsonResponse({ value: null }));

        const result = await runDriveType([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'session-1',
            '--using', 'id',
            '--value', 'com.example:id/input',
            '--text', 'user@example.com',
            '--clear-first',
        ]);

        expect(result.command).toBe('drive.type');
        expect((result.result as any).clearFirst).toBe(true);
        expect(fetchMock.mock.calls[1][0]).toContain('/clear');
        expect(fetchMock.mock.calls[2][0]).toContain('/value');
    });

    it('navigates back', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ value: null }));

        await runDriveBack([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'session-1',
        ]);

        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:4723/session/session-1/back',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('performs swipe gesture', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ value: null }))
            .mockResolvedValueOnce(jsonResponse({ value: null }));

        await runDriveSwipe([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'session-1',
            '--from', '100,700',
            '--to', '100,200',
            '--duration-ms', '350',
        ]);

        expect(fetchMock.mock.calls[0][0]).toContain('/actions');
        expect(fetchMock.mock.calls[1][0]).toContain('/actions');
        expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('DELETE');
    });

    it('scrolls down with correct W3C actions payload', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ value: { width: 1000, height: 2000 } }))
            .mockResolvedValueOnce(jsonResponse({ value: null }))
            .mockResolvedValueOnce(jsonResponse({ value: null }));

        const result = await runDriveScroll([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'session-1',
            '--direction', 'down',
        ]);

        expect(result.command).toBe('drive.scroll');
        expect((result.result as any).direction).toBe('down');

        expect(fetchMock.mock.calls[0][0]).toContain('/session/session-1/window/rect');

        const actionsCall = fetchMock.mock.calls[1];
        expect(actionsCall[0]).toContain('/session/session-1/actions');
        const body = JSON.parse((actionsCall[1] as RequestInit).body as string);
        const pointerActions = body.actions[0].actions;
        expect(pointerActions[0]).toEqual({ type: 'pointerMove', duration: 0, x: 500, y: 1600 });
        expect(pointerActions[3]).toEqual({ type: 'pointerMove', duration: 300, x: 500, y: 400 });

        expect(fetchMock.mock.calls[2][0]).toContain('/actions');
        expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe('DELETE');
    });

    it('falls back to /window/size when /window/rect fails', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ value: { error: 'unknown command', message: 'not supported' } }, 404))
            .mockResolvedValueOnce(jsonResponse({ value: { width: 1200, height: 1800 } }))
            .mockResolvedValueOnce(jsonResponse({ value: null }))
            .mockResolvedValueOnce(jsonResponse({ value: null }));

        await runDriveScroll([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'session-1',
            '--direction', 'left',
        ]);

        expect(fetchMock.mock.calls[0][0]).toContain('/session/session-1/window/rect');
        expect(fetchMock.mock.calls[1][0]).toContain('/session/session-1/window/size');

        const actionsCall = fetchMock.mock.calls[2];
        expect(actionsCall[0]).toContain('/session/session-1/actions');
        const body = JSON.parse((actionsCall[1] as RequestInit).body as string);
        const pointerActions = body.actions[0].actions;
        expect(pointerActions[0]).toEqual({ type: 'pointerMove', duration: 0, x: 960, y: 900 });
        expect(pointerActions[3]).toEqual({ type: 'pointerMove', duration: 300, x: 240, y: 900 });

        expect(fetchMock.mock.calls[3][0]).toContain('/actions');
        expect((fetchMock.mock.calls[3][1] as RequestInit).method).toBe('DELETE');
    });

    it('rejects invalid scroll direction', async () => {
        await expect(runDriveScroll([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'session-1',
            '--direction', 'diagonal',
        ])).rejects.toThrow('--direction must be one of: up, down, left, right');
    });
});
