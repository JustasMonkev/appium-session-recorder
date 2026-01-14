import { describe, it, expect } from 'vitest';
import { parseXmlSource } from '../xml-parser';

describe('parseXmlSource', () => {
    describe('basic parsing', () => {
        it('should parse empty XML', () => {
            const xml = '<root></root>';
            const result = parseXmlSource(xml);

            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('root');
        });

        it('should parse XML with type attribute', () => {
            const xml = '<root type="XCUIElementTypeApplication"></root>';
            const result = parseXmlSource(xml);

            expect(result[0].type).toBe('XCUIElementTypeApplication');
        });

        it('should use tagName when type attribute is missing', () => {
            const xml = '<CustomElement></CustomElement>';
            const result = parseXmlSource(xml);

            expect(result[0].type).toBe('CustomElement');
        });
    });

    describe('element attributes', () => {
        it('should parse name attribute', () => {
            const xml = '<element name="LoginButton"></element>';
            const result = parseXmlSource(xml);

            expect(result[0].name).toBe('LoginButton');
        });

        it('should parse label attribute', () => {
            const xml = '<element label="Login"></element>';
            const result = parseXmlSource(xml);

            expect(result[0].label).toBe('Login');
        });

        it('should parse value attribute', () => {
            const xml = '<element value="test@example.com"></element>';
            const result = parseXmlSource(xml);

            expect(result[0].value).toBe('test@example.com');
        });

        it('should parse enabled attribute', () => {
            const xml = '<element enabled="true"></element>';
            const result = parseXmlSource(xml);

            expect(result[0].enabled).toBe(true);
        });

        it('should parse visible attribute', () => {
            const xml = '<element visible="true"></element>';
            const result = parseXmlSource(xml);

            expect(result[0].visible).toBe(true);
        });

        it('should parse accessible attribute', () => {
            const xml = '<element accessible="true"></element>';
            const result = parseXmlSource(xml);

            expect(result[0].accessible).toBe(true);
        });

        it('should default boolean attributes to false', () => {
            const xml = '<element></element>';
            const result = parseXmlSource(xml);

            expect(result[0].enabled).toBe(false);
            expect(result[0].visible).toBe(false);
            expect(result[0].accessible).toBe(false);
        });

        it('should default string attributes to empty string', () => {
            const xml = '<element></element>';
            const result = parseXmlSource(xml);

            expect(result[0].name).toBe('');
            expect(result[0].label).toBe('');
            expect(result[0].value).toBe('');
        });
    });

    describe('coordinates', () => {
        it('should parse x, y, width, height attributes', () => {
            const xml = '<element x="100" y="200" width="50" height="30"></element>';
            const result = parseXmlSource(xml);

            expect(result[0].x).toBe(100);
            expect(result[0].y).toBe(200);
            expect(result[0].width).toBe(50);
            expect(result[0].height).toBe(30);
        });

        it('should default coordinates to 0', () => {
            const xml = '<element></element>';
            const result = parseXmlSource(xml);

            expect(result[0].x).toBe(0);
            expect(result[0].y).toBe(0);
            expect(result[0].width).toBe(0);
            expect(result[0].height).toBe(0);
        });

        it('should handle negative coordinates', () => {
            const xml = '<element x="-10" y="-20"></element>';
            const result = parseXmlSource(xml);

            expect(result[0].x).toBe(-10);
            expect(result[0].y).toBe(-20);
        });
    });

    describe('xpath generation', () => {
        it('should generate xpath for root element', () => {
            const xml = '<root></root>';
            const result = parseXmlSource(xml);

            expect(result[0].xpath).toBe('/root[1]');
        });

        it('should generate xpath with type attribute', () => {
            const xml = '<root type="XCUIElementTypeApplication"></root>';
            const result = parseXmlSource(xml);

            expect(result[0].xpath).toBe('/XCUIElementTypeApplication[1]');
        });

        it('should generate nested xpath', () => {
            const xml = `
                <app type="Application">
                    <window type="Window">
                        <button type="Button"></button>
                    </window>
                </app>
            `;
            const result = parseXmlSource(xml);

            expect(result[0].xpath).toBe('/Application[1]');
            expect(result[1].xpath).toBe('/Application[1]/Window[1]');
            expect(result[2].xpath).toBe('/Application[1]/Window[1]/Button[1]');
        });

        it('should generate xpath with sibling indexing', () => {
            const xml = `
                <app type="Application">
                    <button type="Button"></button>
                    <button type="Button"></button>
                    <button type="Button"></button>
                </app>
            `;
            const result = parseXmlSource(xml);

            expect(result[1].xpath).toBe('/Application[1]/Button[1]');
            expect(result[2].xpath).toBe('/Application[1]/Button[2]');
            expect(result[3].xpath).toBe('/Application[1]/Button[3]');
        });

        it('should handle mixed child types', () => {
            const xml = `
                <app type="Application">
                    <button type="Button"></button>
                    <text type="Text"></text>
                    <button type="Button"></button>
                </app>
            `;
            const result = parseXmlSource(xml);

            expect(result[1].xpath).toBe('/Application[1]/Button[1]');
            expect(result[2].xpath).toBe('/Application[1]/Text[1]');
            expect(result[3].xpath).toBe('/Application[1]/Button[2]');
        });
    });

    describe('nested elements', () => {
        it('should parse all nested elements', () => {
            const xml = `
                <app type="Application">
                    <window type="Window">
                        <view type="View">
                            <button type="Button"></button>
                            <text type="Text"></text>
                        </view>
                    </window>
                </app>
            `;
            const result = parseXmlSource(xml);

            expect(result).toHaveLength(5);
            expect(result.map(e => e.type)).toEqual([
                'Application',
                'Window',
                'View',
                'Button',
                'Text',
            ]);
        });

        it('should preserve element order (depth-first)', () => {
            const xml = `
                <root>
                    <a>
                        <b></b>
                    </a>
                    <c></c>
                </root>
            `;
            const result = parseXmlSource(xml);

            expect(result.map(e => e.type)).toEqual(['root', 'a', 'b', 'c']);
        });
    });

    describe('real-world Appium XML', () => {
        it('should parse iOS page source', () => {
            const xml = `
                <AppiumAUT type="XCUIElementTypeApplication" name="MyApp" label="" enabled="true" visible="true">
                    <XCUIElementTypeWindow type="XCUIElementTypeWindow" enabled="true" visible="true" x="0" y="0" width="390" height="844">
                        <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" x="0" y="0" width="390" height="844">
                            <XCUIElementTypeButton type="XCUIElementTypeButton" name="loginButton" label="Log In" enabled="true" visible="true" x="20" y="400" width="350" height="44">
                            </XCUIElementTypeButton>
                        </XCUIElementTypeOther>
                    </XCUIElementTypeWindow>
                </AppiumAUT>
            `;
            const result = parseXmlSource(xml);

            expect(result).toHaveLength(4);

            const button = result.find(e => e.type === 'XCUIElementTypeButton');
            expect(button).toBeDefined();
            expect(button!.name).toBe('loginButton');
            expect(button!.label).toBe('Log In');
            expect(button!.enabled).toBe(true);
            expect(button!.visible).toBe(true);
            expect(button!.x).toBe(20);
            expect(button!.y).toBe(400);
            expect(button!.width).toBe(350);
            expect(button!.height).toBe(44);
        });

        it('should parse Android page source', () => {
            const xml = `
                <hierarchy type="android.widget.FrameLayout">
                    <android.widget.LinearLayout type="android.widget.LinearLayout" x="0" y="0" width="1080" height="2400">
                        <android.widget.Button type="android.widget.Button" name="" label="" value="" enabled="true" visible="true" x="100" y="500" width="200" height="80">
                        </android.widget.Button>
                    </android.widget.LinearLayout>
                </hierarchy>
            `;
            const result = parseXmlSource(xml);

            expect(result).toHaveLength(3);
            expect(result.map(e => e.type)).toEqual([
                'android.widget.FrameLayout',
                'android.widget.LinearLayout',
                'android.widget.Button',
            ]);
        });
    });

    describe('edge cases', () => {
        it('should handle empty document', () => {
            const xml = '';
            // parseXmlSource expects valid XML, empty string may produce error
            // In real usage, empty strings are filtered out before calling
            const result = parseXmlSource(xml);
            // DOMParser will create an error document or empty result
            expect(Array.isArray(result)).toBe(true);
        });

        it('should handle deeply nested elements', () => {
            const xml = `
                <level1 type="L1">
                    <level2 type="L2">
                        <level3 type="L3">
                            <level4 type="L4">
                                <level5 type="L5">
                                </level5>
                            </level4>
                        </level3>
                    </level2>
                </level1>
            `;
            const result = parseXmlSource(xml);

            expect(result).toHaveLength(5);
            expect(result[4].xpath).toBe('/L1[1]/L2[1]/L3[1]/L4[1]/L5[1]');
        });

        it('should handle elements with special characters in attributes', () => {
            const xml = '<element name="Button &amp; Text" label="Click &lt;here&gt;"></element>';
            const result = parseXmlSource(xml);

            expect(result[0].name).toBe('Button & Text');
            expect(result[0].label).toBe('Click <here>');
        });

        it('should handle many sibling elements', () => {
            let children = '';
            for (let i = 0; i < 100; i++) {
                children += `<item type="Item" name="item${i}"></item>`;
            }
            const xml = `<root>${children}</root>`;
            const result = parseXmlSource(xml);

            expect(result).toHaveLength(101); // root + 100 items
            expect(result[100].xpath).toBe('/root[1]/Item[100]');
        });

        it('should include node reference in result', () => {
            const xml = '<element name="TestElement"></element>';
            const result = parseXmlSource(xml);

            expect(result[0].node).toBeDefined();
            expect(result[0].node instanceof Element).toBe(true);
        });
    });
});
