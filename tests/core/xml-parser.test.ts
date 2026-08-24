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

    it('matches DOM attribute entity and whitespace normalization', () => {
        const xml = '<hierarchy><node class="android.widget.TextView" text="literal\tline\nbreak&#10;hex&#x9;&amp;#10;"/></hierarchy>';
        const element = parseSource(xml).elements[1];

        expect(element.text).toBe('literal line break\nhex\t&#10;');
        expect(element.attributes.text).toBe('literal line break\nhex\t&#10;');
    });

    it('decodes supplementary numeric references and rejects illegal ones without throwing', () => {
        expect(parseSource('<Root text="&#x1F600;"/>').elements[0].text).toBe('😀');
        for (const reference of ['&#0;', '&#xD800;', '&#x110000;', '&#1114112;', `&#${'9'.repeat(100)};`]) {
            expect(parseSource(`<Root text="${reference}"/>`).elements).toEqual([]);
        }
    });

    it('treats numeric false visibility attributes as hidden', () => {
        const elements = parseSource('<Root><A visible="0"/><B displayed="0"/><C visible="1"/></Root>').elements;

        expect(elements.slice(1).map(element => element.visible)).toEqual([false, false, true]);
    });

    it('returns empty result for invalid XML', () => {
        const parsed = parseSource('not xml');
        expect(parsed.platform).toBe('unknown');
        expect(parsed.elements).toEqual([]);
    });

    it('ignores an XML declaration and parses the document root', () => {
        const parsed = parseSource(
            '<?xml version="1.0" encoding="UTF-8"?><hierarchy><node class="android.widget.Button" /></hierarchy>',
        );

        expect(parsed.elements.map(element => element.type)).toEqual(['hierarchy', 'android.widget.Button']);
        expect(parsed.elements[1].xpath).toBe('/hierarchy[1]/node[1]');
    });

    it('parses declared namespace prefixes and rejects invalid bindings', () => {
        const valid = parseSource('<root xmlns:p="urn:test"><p:a p:x="1"/></root>');
        expect(valid.elements[1]).toMatchObject({
            type: 'p:a',
            attributes: { 'p:x': '1' },
        });
        expect(parseSource(
            '<root xmlns:xml="http://www.w3.org/XML/1998/namespac&#x65;" xml:lang="en"/>',
        ).elements[0].attributes['xml:lang']).toBe('en');
        for (const xml of [
            '<p:a/>',
            '<a p:x="1"/>',
            '<a xmlns:xml="bad"/>',
            '<a xmlns:xmlns="urn:test"/>',
            '<a xmlns:p="urn:test" xmlns:q="urn:test" p:x="1" q:x="2"/>',
            '<a xmlns:p="http://www.w3.org/2000/xmln&#x73;/"/>',
        ]) {
            expect(parseSource(xml).elements).toEqual([]);
        }
    });

    it('indexes inherited-property tag names without corrupting sibling paths', () => {
        const parsed = parseSource('<root><__proto__/><__proto__/><constructor/><constructor/></root>');
        expect(parsed.elements.slice(1).map(element => element.xpath)).toEqual([
            '/root[1]/__proto__[1]',
            '/root[1]/__proto__[2]',
            '/root[1]/constructor[1]',
            '/root[1]/constructor[2]',
        ]);
    });

    it('round-trips parser-sensitive tag and attribute names without prototype pollution', () => {
        const names = [
            '__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf',
            '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
            '_asr_', '_asr_5f_5f_70_72_6f_74_6f_5f_5f',
        ];
        const xml = `<root>${names.map((name, index) => `<${name} ${name}="value-${index}"/>`).join('')}</root>`;
        const elements = parseSource(xml).elements.slice(1);

        expect(elements.map(element => element.xpath.split('/').slice(-1)[0])).toEqual(
            names.map(name => `${name}[1]`),
        );
        for (let index = 0; index < names.length; index++) {
            expect(Object.hasOwn(elements[index].attributes, names[index])).toBe(true);
            expect(elements[index].attributes[names[index]]).toBe(`value-${index}`);
        }
        expect(Object.getPrototypeOf(elements[0].attributes)).toBe(Object.prototype);
    });

    it('preserves mixed sibling order and per-type indexes', () => {
        const parsed = parseSource(`
            <Root>
                <Button name="first" />
                <Text name="middle" />
                <Button name="last" />
            </Root>
        `);

        expect(parsed.elements.map(element => element.name)).toEqual(['', 'first', 'middle', 'last']);
        expect(parsed.elements.slice(1).map(element => element.xpath)).toEqual([
            '/Root[1]/Button[1]',
            '/Root[1]/Text[1]',
            '/Root[1]/Button[2]',
        ]);
    });

    it('bounds deeply nested XML without overflowing the call stack', () => {
        const depth = 300;
        const xml = `${'<Node>'.repeat(depth)}${'</Node>'.repeat(depth)}`;

        const parsed = parseSource(xml);

        expect(parsed.elements).toEqual([]);
    });

    it('rejects input above the 10,000-element boundary', () => {
        const xml = `<Root>${'<Item />'.repeat(10_005)}</Root>`;

        expect(parseSource(xml).elements).toEqual([]);
    });

    it('rejects XML larger than 10,000,000 characters', () => {
        expect(parseSource(`<Root>${'x'.repeat(10_000_000)}</Root>`).elements).toEqual([]);
    });

    it('rejects XML whose derived absolute paths exceed the aggregate budget', () => {
        const tag = `T${'x'.repeat(511)}`;
        const xml = `${`<${tag}>`.repeat(95)}${`<${tag}/>` .repeat(140)}${`</${tag}>`.repeat(95)}`;

        expect(parseSource(xml).elements).toEqual([]);
    });
});
