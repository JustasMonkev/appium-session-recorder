import { describe, it, expect } from 'vitest';
import { parseSource } from '../../src/core/xml/parse-source';

describe('parseSource', () => {
    it('parses iOS source with normalized metadata', () => {
        const xml = `
            <AppiumAUT type="XCUIElementTypeApplication" name="MyApp" enabled="true" visible="true">
                <XCUIElementTypeWindow type="XCUIElementTypeWindow" enabled="true" visible="true">
                    <XCUIElementTypeButton type="XCUIElementTypeButton" name="loginButton" label="Log In" enabled="true" visible="true" x="20" y="400" width="350" height="44" clickable="true" />
                </XCUIElementTypeWindow>
            </AppiumAUT>
        `;

        const parsed = parseSource(xml);

        expect(parsed.platform).toBe('ios');
        expect(parsed.elements.length).toBe(3);

        const button = parsed.elements.find(element => element.type === 'XCUIElementTypeButton');
        expect(button).toBeDefined();
        expect(button?.name).toBe('loginButton');
        expect(button?.label).toBe('Log In');
        expect(button?.x).toBe(20);
        expect(button?.width).toBe(350);
        expect(button?.elementRef).toMatch(/^ios:/);
    });

    it('parses Android bounds and strategy attributes', () => {
        const xml = `
            <hierarchy>
                <android.widget.FrameLayout class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
                    <android.widget.Button class="android.widget.Button" text="Continue" content-desc="continueButton" resource-id="com.example:id/continue" bounds="[50,1900][1030,2050]" enabled="true" visible="true" clickable="true" />
                </android.widget.FrameLayout>
            </hierarchy>
        `;

        const parsed = parseSource(xml);

        expect(parsed.platform).toBe('android');

        const button = parsed.elements.find(element => element.type === 'android.widget.Button');
        expect(button).toBeDefined();
        expect(button?.resourceId).toBe('com.example:id/continue');
        expect(button?.contentDesc).toBe('continueButton');
        expect(button?.x).toBe(50);
        expect(button?.y).toBe(1900);
        expect(button?.width).toBe(980);
        expect(button?.height).toBe(150);
    });

    it('returns empty result for invalid XML', () => {
        const parsed = parseSource('not xml');
        expect(parsed.platform).toBe('unknown');
        expect(parsed.elements).toEqual([]);
    });
});
