import { describe, it, expect } from 'vitest';
import { parseXmlDocument, parseXmlSource } from '../xml-parser';
import { generateSelectorCandidates } from '../../../../core/selectors/generate-candidates';
import { parseSource } from '../../../../core/xml/parse-source';

function generateLocators(element: Parameters<typeof generateSelectorCandidates>[0]) {
    return generateSelectorCandidates(element).map(({ strategy, value }) => ({ strategy, value }));
}

describe('parseXmlSource', () => {
    it('matches the core parser for recovered browser HTML', () => {
        const html = `<!doctype html><html><head><meta charset=utf-8></head><body>
            <ul><li id=first title="A&nbsp;B">First<li id=second>Second</ul>
            <noscript><button id=fallback>Fallback</button></noscript>
            <svg><circle id=dot></circle></svg>
            <div hidden><button id=hidden-child>Hidden</button></div>
            <fieldset disabled><legend><input id=legend-child></legend><legend><input id=second-legend-child></legend><input id=blocked></fieldset>
            <select disabled><option id=select-option>Disabled</option></select>
            <select><optgroup disabled><option id=group-option>Disabled</option></optgroup></select>
            <input id=email disabled><button id=save class=primary>Save</button>
        </body></html>`;
        const parsed = parseXmlDocument(html);
        const core = parseSource(html).elements;
        const values = (elements: typeof core) => elements.map(({
            type, xpath, resourceId, attributes, enabled, clickable, visible,
        }) => ({ type, xpath, resourceId, attributes, enabled, clickable, visible }));

        expect(values(parsed.elements)).toEqual(values(core));
        expect(parsed.elements.find(element => element.resourceId === 'email')).toMatchObject({
            type: 'input', enabled: false, clickable: false, attributes: { disabled: '' },
        });
        expect(parsed.elements.find(element => element.resourceId === 'hidden-child')).toMatchObject({
            visible: false, clickable: false,
        });
        expect(parsed.elements.find(element => element.resourceId === 'legend-child')).toMatchObject({
            enabled: true, clickable: true,
        });
        expect(parsed.elements.find(element => element.resourceId === 'second-legend-child')).toMatchObject({
            enabled: false, clickable: false,
        });
        expect(parsed.elements.find(element => element.resourceId === 'blocked')).toMatchObject({
            enabled: false, clickable: false,
        });
        expect(parsed.elements.find(element => element.resourceId === 'select-option')).toMatchObject({
            enabled: false, clickable: false,
        });
        expect(parsed.elements.find(element => element.resourceId === 'group-option')).toMatchObject({
            enabled: false, clickable: false,
        });
        const button = parsed.elements.find(element => element.resourceId === 'save')!;
        expect(parsed.doc.evaluate(
            button.xpath,
            parsed.doc,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
        ).singleNodeValue).toBe(button.node);
        const circle = parsed.elements.find(element => element.resourceId === 'dot')!;
        expect(circle.xpath).toBe(
            '/html[1]/body[1]/*[local-name(.)="svg"][1]/*[local-name(.)="circle"][1]',
        );
        expect(parsed.doc.evaluate(
            circle.xpath,
            parsed.doc,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
        ).singleNodeValue).toBe(circle.node);
    });

    it('keeps core and UI HTML behavior aligned across deterministic generated documents', () => {
        let state = 0x51f15e;
        const next = () => (state = (state * 1_664_525 + 1_013_904_223) >>> 0);

        for (let caseIndex = 0; caseIndex < 100; caseIndex++) {
            const children = Array.from({ length: 1 + next() % 20 }, (_, index) => {
                const id = `item-${caseIndex}-${index}`;
                if (next() % 3 === 0) return `<input id=${id}${next() % 2 ? ' disabled' : ''}>`;
                const tag = next() % 2 ? 'button' : 'div';
                return `<${tag} id=${id} class="c${next() % 5}">&amp;</${tag}>`;
            }).join('');
            const html = `<!doctype html><html><body><ul><li id=a>A<li id=b>B</ul>${children}</body></html>`;
            const core = parseSource(html).elements.map(element => ({
                type: element.type,
                xpath: element.xpath,
                resourceId: element.resourceId,
                enabled: element.enabled,
                clickable: element.clickable,
                attributes: element.attributes,
            }));
            const ui = parseXmlSource(html).map(element => ({
                type: element.type,
                xpath: element.xpath,
                resourceId: element.resourceId,
                enabled: element.enabled,
                clickable: element.clickable,
                attributes: element.attributes,
            }));

            expect(ui).toEqual(core);
        }
    });

    it('evaluates XPath locators for escaped HTML element names', () => {
        const html = '<html><body><x"y id=quoted></x"y><x:y id=colon></x:y><math-α id=unicode></math-α></body></html>';
        const parsed = parseXmlDocument(html);
        const core = parseSource(html).elements;

        for (const id of ['quoted', 'colon', 'unicode']) {
            const element = parsed.elements.find(candidate => candidate.resourceId === id)!;
            expect(element.xpath).toBe(core.find(candidate => candidate.resourceId === id)?.xpath);
            expect(parsed.doc.evaluate(
                element.xpath,
                parsed.doc,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
            ).singleNodeValue).toBe(element.node);
        }
    });

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

        it('parses a valid element literally named parsererror', () => {
            const result = parseXmlSource('<parsererror><node/></parsererror>');

            expect(result.map(element => element.type)).toEqual(['parsererror', 'node']);
        });

        it('parses declared namespace prefixes and rejects invalid bindings', () => {
            const valid = parseXmlSource('<root xmlns:p="urn:test"><p:a p:x="1"/></root>');
            expect(valid[1]).toMatchObject({ type: 'p:a', attributes: { 'p:x': '1' } });
            expect(parseXmlSource(
                '<root xmlns:xml="http://www.w3.org/XML/1998/namespac&#x65;" xml:lang="en"/>',
            )[0].attributes['xml:lang']).toBe('en');
            for (const xml of [
                '<p:a/>',
                '<a p:x="1"/>',
                '<a xmlns:xml="bad"/>',
                '<a xmlns:xmlns="urn:test"/>',
                '<a xmlns:p="urn:test" xmlns:q="urn:test" p:x="1" q:x="2"/>',
                '<a xmlns:p="http://www.w3.org/2000/xmln&#x73;/"/>',
            ]) {
                expect(parseXmlSource(xml)).toEqual([]);
            }
        });

        it.each([
            '<root>&bogus;</root>',
            '<root a="&bogus;"/>',
            '<root><!--x--y--></root>',
            '<root xmlns:x=""><x:a/></root>',
        ])('rejects malformed XML instead of parsing the browser error document: %s', xml => {
            expect(parseXmlSource(xml)).toEqual([]);
        });
    });

    describe('element attributes', () => {
        it('normalizes literal XML whitespace and decodes numeric references once', () => {
            const xml = '<element text="literal\tline\nbreak&#10;hex&#x9;&amp;#10;"></element>';
            const result = parseXmlSource(xml);

            expect(result[0].text).toBe('literal line break\nhex\t&#10;');
        });

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

        it('should default enabled and accessible to false', () => {
            const xml = '<element></element>';
            const result = parseXmlSource(xml);

            expect(result[0].enabled).toBe(false);
            expect(result[0].accessible).toBe(false);
        });

        it('should default visible to true when the attribute is omitted', () => {
            const xml = '<element></element>';
            const result = parseXmlSource(xml);

            expect(result[0].visible).toBe(true);
        });

        it('should treat displayed="false" as not visible', () => {
            const xml = '<element displayed="false"></element>';
            const result = parseXmlSource(xml);

            expect(result[0].visible).toBe(false);
        });

        it('treats visible="0" and displayed="0" as not visible', () => {
            const result = parseXmlSource('<root><a visible="0"/><b displayed="0"/><c visible="1"/></root>');

            expect(result.slice(1).map(element => element.visible)).toEqual([false, false, true]);
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

            expect(result[0].xpath).toBe('/root[1]');
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

            expect(result[0].xpath).toBe('/app[1]');
            expect(result[1].xpath).toBe('/app[1]/window[1]');
            expect(result[2].xpath).toBe('/app[1]/window[1]/button[1]');
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

            expect(result[1].xpath).toBe('/app[1]/button[1]');
            expect(result[2].xpath).toBe('/app[1]/button[2]');
            expect(result[3].xpath).toBe('/app[1]/button[3]');
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

            expect(result[1].xpath).toBe('/app[1]/button[1]');
            expect(result[2].xpath).toBe('/app[1]/text[1]');
            expect(result[3].xpath).toBe('/app[1]/button[2]');
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

        it('builds absolute XPath locators that select the parsed DOM node', () => {
            const parsed = parseXmlDocument(
                '<app type="Application"><node class="android.widget.Button" text="Continue" /></app>',
            );
            const button = parsed.elements[1];
            const xpath = generateLocators(button).find(locator => (
                locator.strategy === 'xpath' && locator.value === '/app[1]/node[1]'
            ));

            expect(xpath?.value).toBe('/app[1]/node[1]');
            expect(parsed.doc.evaluate(
                xpath!.value,
                parsed.doc,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
            ).singleNodeValue).toBe(button.node);
        });

        it('builds generic XPath locators that select nodes with class-derived and tag-derived types', () => {
            const parsed = parseXmlDocument(
                '<Root><node class="Button" name="go"/><Button name="tagged"/></Root>',
            );

            for (const element of parsed.elements.slice(1)) {
                const xpath = generateLocators(element).find(locator => (
                    locator.strategy === 'xpath' && locator.value.startsWith('//')
                ));
                expect(xpath).toBeDefined();
                expect(parsed.doc.evaluate(
                    xpath!.value,
                    parsed.doc,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                ).singleNodeValue).toBe(element.node);
            }
        });

        it('indexes inherited-property tag names correctly', () => {
            const result = parseXmlSource('<root><__proto__/><__proto__/><constructor/><constructor/></root>');
            expect(result.slice(1).map(element => element.xpath)).toEqual([
                '/root[1]/__proto__[1]',
                '/root[1]/__proto__[2]',
                '/root[1]/constructor[1]',
                '/root[1]/constructor[2]',
            ]);
        });

        it('round-trips parser-sensitive tag and attribute names', () => {
            const names = [
                '__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf',
                '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', '_asr_',
            ];
            const xml = `<root>${names.map((name, index) => `<${name} ${name}="v${index}"/>`).join('')}</root>`;
            const elements = parseXmlSource(xml).slice(1);

            expect(elements.map(element => element.xpath.split('/').slice(-1)[0])).toEqual(
                names.map(name => `${name}[1]`),
            );
            names.forEach((name, index) => expect(elements[index].attributes[name]).toBe(`v${index}`));
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
            expect(button).toMatchObject({
                name: 'loginButton',
                label: 'Log In',
                enabled: true,
                visible: true,
                x: 20,
                y: 400,
                width: 350,
                height: 44,
            });
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

        it('should parse standard Android strategy attributes and bounds', () => {
            const result = parseXmlSource(`
                <hierarchy>
                    <node class="android.widget.Button" text="Continue"
                        resource-id="com.example:id/continue" content-desc="continueButton"
                        bounds="[50,1900][1030,2050]" enabled="true" clickable="true" />
                </hierarchy>
            `);

            expect(result[1]).toMatchObject({
                platform: 'android',
                type: 'android.widget.Button',
                text: 'Continue',
                resourceId: 'com.example:id/continue',
                contentDesc: 'continueButton',
                x: 50,
                y: 1900,
                width: 980,
                height: 150,
                clickable: true,
            });
        });
    });

    describe('edge cases', () => {
        it('should handle empty document', () => {
            const xml = '';
            const result = parseXmlSource(xml);
            expect(result).toEqual([]);
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
            expect(result[4].xpath).toBe('/level1[1]/level2[1]/level3[1]/level4[1]/level5[1]');
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

            expect(result).toHaveLength(101);
            expect(result[100].xpath).toBe('/root[1]/item[100]');
        });

        it('should include node reference in result', () => {
            const xml = '<element name="TestElement"></element>';
            const result = parseXmlSource(xml);

            expect(result[0].node).toBeDefined();
            expect(result[0].node instanceof Element).toBe(true);
        });

        it('should bound 6,000 nested elements without a RangeError', () => {
            const depth = 6_000;
            const xml = `${'<Node>'.repeat(depth)}${'</Node>'.repeat(depth)}`;

            expect(parseXmlSource(xml)).toEqual([]);
        });

        it('should reject input above 10,000 elements', () => {
            const xml = `<Root>${'<Item />'.repeat(10_005)}</Root>`;

            expect(parseXmlSource(xml)).toEqual([]);
        });

        it('should reject oversized XML before traversal', () => {
            const xml = `<Root>${'x'.repeat(10_000_000)}</Root>`;

            expect(parseXmlSource(xml)).toEqual([]);
        });

        it('rejects XML whose derived absolute paths exceed the aggregate budget', () => {
            const tag = `T${'x'.repeat(511)}`;
            const xml = `${`<${tag}>`.repeat(95)}${`<${tag}/>` .repeat(140)}${`</${tag}>`.repeat(95)}`;

            expect(parseXmlSource(xml)).toEqual([]);
        });
    });
});
