import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runSessionCreate, runSessionDelete } from '../../src/cli/commands/session';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('session commands', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('creates session from inline capabilities', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            jsonResponse({
                sessionId: 'abc123',
                value: { capabilities: { platformName: 'iOS' } },
            }),
        );

        const result = await runSessionCreate([
            '--appium-url', 'http://127.0.0.1:4723',
            '--caps-json', '{"platformName":"iOS","appium:automationName":"XCUITest"}',
        ]);

        expect(result.command).toBe('session.create');
        expect((result.result as any).sessionId).toBe('abc123');

        const [, options] = fetchMock.mock.calls[0];
        const payload = JSON.parse(String(options?.body));
        expect(payload.capabilities.alwaysMatch.platformName).toBe('iOS');
    });

    it('deletes existing session', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ value: null }));

        const result = await runSessionDelete([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'abc123',
        ]);

        expect(result.command).toBe('session.delete');
        expect((result.result as any).deleted).toBe(true);

        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:4723/session/abc123',
            expect.objectContaining({ method: 'DELETE' }),
        );
    });
});
