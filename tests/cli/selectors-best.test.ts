import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSource } from '../../src/core/xml/parse-source';
import { runSelectorsBest } from '../../src/cli/commands/selectors';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('selectors best command', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('returns ranked selectors for a chosen element', async () => {
        const source = `
            <AppiumAUT type="XCUIElementTypeApplication">
                <XCUIElementTypeWindow type="XCUIElementTypeWindow">
                    <XCUIElementTypeButton type="XCUIElementTypeButton" name="loginBtn" label="Log In" enabled="true" visible="true" clickable="true" />
                </XCUIElementTypeWindow>
            </AppiumAUT>
        `;

        const parsed = parseSource(source);
        const target = parsed.elements.find(element => element.type === 'XCUIElementTypeButton');
        if (!target) throw new Error('Expected the fixture to contain a button');

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ value: source }));

        const result = await runSelectorsBest([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'session-1',
            '--element-ref', target.elementRef,
        ]);

        expect(result.command).toBe('selectors.best');
        expect(result.result).toEqual(expect.objectContaining({
            topSelectors: expect.arrayContaining([expect.objectContaining({
                reasons: expect.arrayContaining(['UNIQUE_MATCH']),
            })]),
        }));
    });
});
