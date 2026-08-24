import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runScreenElements, runScreenSnapshot } from '../../src/cli/commands/screen';

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
    });
}

const source = `
    <hierarchy>
        <node class="android.widget.Button" text="Continue" content-desc="continue"
            enabled="true" clickable="true" bounds="[0,0][100,50]" />
        <node class="android.widget.TextView" text="Disabled"
            enabled="false" bounds="[0,60][100,100]" />
    </hierarchy>
`;

describe('screen commands', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('captures a typed snapshot with parsed metadata', async () => {
        const screenshot = Buffer.from('png').toString('base64');
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input =>
            String(input).endsWith('/source')
                ? jsonResponse({ value: source })
                : jsonResponse({ value: screenshot })
        );

        const result = await runScreenSnapshot([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'session-1',
        ]);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            command: 'screen.snapshot',
            result: {
                sessionId: 'session-1',
                platform: 'android',
                screenshot,
                source,
                metadata: { elementCount: 3 },
            },
        });
    });

    it('preserves bounded HTML sources for web-context commands', async () => {
        const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><button id=save>Save</button><input id=email disabled><div hidden><button id=hidden>Hidden</button></div></body></html>';
        const screenshot = Buffer.from('png').toString('base64');
        vi.spyOn(globalThis, 'fetch').mockImplementation(async input =>
            String(input).endsWith('/source')
                ? jsonResponse({ value: html })
                : jsonResponse({ value: screenshot })
        );

        await expect(runScreenSnapshot([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'web-session',
        ])).resolves.toMatchObject({
            result: { source: html, screenshot, platform: 'unknown', metadata: { elementCount: 8 } },
        });
        await expect(runScreenElements([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'web-session',
        ])).resolves.toMatchObject({
            command: 'screen.elements',
            result: {
                total: 8,
                returned: 8,
                elements: expect.arrayContaining([
                    expect.objectContaining({ type: 'button', resourceId: 'save', xpath: '/html[1]/body[1]/button[1]' }),
                    expect.objectContaining({ type: 'input', resourceId: 'email', enabled: false }),
                ]),
            },
        });
        await expect(runScreenElements([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'web-session',
            '--only-actionable',
        ])).resolves.toMatchObject({
            result: {
                total: 8,
                returned: 1,
                elements: [expect.objectContaining({ resourceId: 'save', clickable: true })],
            },
        });
    });

    it('filters actionable elements before applying the result limit', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ value: source }));

        const result = await runScreenElements([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'session-1',
            '--only-actionable',
            '--limit', '1',
        ]);

        expect(result).toMatchObject({
            command: 'screen.elements',
            result: {
                total: 3,
                returned: 1,
                onlyActionable: true,
                elements: [expect.objectContaining({ text: 'Continue', clickable: true })],
            },
        });
    });

    it.each(['0', '-1', '1.5'])('rejects invalid element limit %s', async limit => {
        const fetchMock = vi.spyOn(globalThis, 'fetch');

        await expect(runScreenElements([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'session-1',
            '--limit', limit,
        ])).rejects.toThrow('--limit must be a positive integer');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a value attached to a boolean flag', async () => {
        await expect(runScreenElements([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'session-1',
            '--only-actionable=false',
        ])).rejects.toThrow('--only-actionable does not take a value');
    });
});
