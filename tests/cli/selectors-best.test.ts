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
        expect(target).toBeDefined();

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ value: source }));

        const result = await runSelectorsBest([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'session-1',
            '--element-ref', target!.elementRef,
        ]);

        expect(result.command).toBe('selectors.best');
        expect((result.result as any).topSelectors.length).toBeGreaterThan(0);
        expect((result.result as any).topSelectors[0].reasons).toContain('UNIQUE_MATCH');
    });
});
