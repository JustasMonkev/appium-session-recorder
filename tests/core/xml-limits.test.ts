import { describe, expect, it } from 'vitest';
import {
    isSourceWithinLimits,
    isXmlWithinLimits,
    MAX_XML_ATTRIBUTES,
    MAX_XML_CHARS,
    MAX_XML_MARKUP_CHARS,
    MAX_XML_TOKENS,
} from '../../src/core/xml/xml-limits';

describe('XML resource limits', () => {
    it('accepts bounded HTML page sources without weakening malformed XML rejection', () => {
        expect(isSourceWithinLimits(
            '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><input disabled></body></html>',
        )).toBe(true);
        expect(isSourceWithinLimits('<html><body>web context</body></html>')).toBe(true);
        expect(isSourceWithinLimits('<a></b>')).toBe(false);
        expect(isSourceWithinLimits('<html>\0</html>')).toBe(false);
        expect(isSourceWithinLimits(`<html>${'x'.repeat(MAX_XML_CHARS)}</html>`)).toBe(false);
    });

    it('accepts Appium XML with quoted delimiters, comments, and CDATA', () => {
        expect(isXmlWithinLimits(
            '<Root value="1 > 0"><!-- <ignored /> --><![CDATA[<ignored />]]><Item /></Root>',
        )).toBe(true);
    });

    it('accepts declared namespaces and rejects unbound or reserved prefixes', () => {
        expect(isXmlWithinLimits('<root xmlns:p="urn:test"><p:a p:x="1"/></root>')).toBe(true);
        expect(isXmlWithinLimits(
            '<root xmlns:xml="http://www.w3.org/XML/1998/namespac&#x65;" xml:lang="en"/>',
        )).toBe(true);
        for (const xml of [
            '<p:a/>',
            '<a p:x="1"/>',
            '<a xmlns:xml="bad"/>',
            '<a xmlns:xmlns="urn:test"/>',
            '<a xmlns:p="http://www.w3.org/XML/1998/namespace"/>',
            '<a xmlns="http://www.w3.org/XML/1998/namespac&#x65;"/>',
            '<a xmlns:p="http://www.w3.org/XML/1998/namespac&#x65;"/>',
            '<a xmlns:p="http://www.w3.org/2000/xmln&#x73;/"/>',
            '<a xmlns:p="urn:test" xmlns:q="urn:test" p:x="1" q:x="2"/>',
        ]) expect(isXmlWithinLimits(xml)).toBe(false);
    });

    it('rejects malformed qualified names', () => {
        for (const xml of [
            '<p:a:b xmlns:p="urn:test"/>',
            '<root a::b="x" xmlns:a="urn:test"/>',
            '<:root/>',
            '<root:/>',
        ]) expect(isXmlWithinLimits(xml)).toBe(false);
    });

    it('handles many inherited namespace bindings without per-element copies', () => {
        const namespaces = Array.from(
            { length: 10_000 },
            (_, index) => ` xmlns:p${index}="urn:${index}"`,
        ).join('');
        const xml = `<root${namespaces}>${'<item/>'.repeat(9_999)}</root>`;
        expect(isXmlWithinLimits(xml)).toBe(true);
    }, 2_000);

    it('accepts exactly 96 nested elements and rejects 97', () => {
        const nested = (depth: number) => `${'<Node>'.repeat(depth)}${'</Node>'.repeat(depth)}`;

        expect(isXmlWithinLimits(nested(96))).toBe(true);
        expect(isXmlWithinLimits(nested(97))).toBe(false);
    });

    it('accepts exactly 10,000 elements and rejects 10,001', () => {
        expect(isXmlWithinLimits(`<Root>${'<Item />'.repeat(9_999)}</Root>`)).toBe(true);
        expect(isXmlWithinLimits(`<Root>${'<Item />'.repeat(10_000)}</Root>`)).toBe(false);
    });

    it('bounds non-element XML nodes at the token limit', () => {
        for (const token of ['<?probe?>', '<!-- probe -->']) {
            expect(isXmlWithinLimits(`<Root>${token.repeat(MAX_XML_TOKENS - 2)}</Root>`)).toBe(true);
            expect(isXmlWithinLimits(`<Root>${token.repeat(MAX_XML_TOKENS - 1)}</Root>`)).toBe(false);
        }
    });

    it('bounds attributes without counting equals signs inside quoted values', () => {
        const document = (count: number) => {
            const nodes: string[] = [];
            for (let offset = 0; offset < count; offset += 20) {
                const attributes = Array.from(
                    { length: Math.min(20, count - offset) },
                    (_, index) => ` a${index}="left=right"`,
                ).join('');
                nodes.push(`<Node${attributes}/>`);
            }
            return `<Root>${nodes.join('')}</Root>`;
        };

        expect(isXmlWithinLimits(document(MAX_XML_ATTRIBUTES))).toBe(true);
        expect(isXmlWithinLimits(document(MAX_XML_ATTRIBUTES + 1))).toBe(false);
    });

    it('accepts a representative attribute-rich Android hierarchy', () => {
        const attributes = Array.from({ length: 20 }, (_, index) => ` a${index}="value=${index}"`).join('');

        expect(isXmlWithinLimits(`<hierarchy>${`<node${attributes}/>` .repeat(1_100)}</hierarchy>`)).toBe(true);
    });

    it('bounds one markup token before parser allocation', () => {
        const prefix = 'Root value="';
        const suffix = '"/';
        const element = (length: number) => `<${prefix}${'x'.repeat(length)}${suffix}>`;
        const boundary = MAX_XML_MARKUP_CHARS - prefix.length - suffix.length;

        expect(isXmlWithinLimits(element(boundary))).toBe(true);
        expect(isXmlWithinLimits(element(boundary + 1))).toBe(false);
        expect(() => isXmlWithinLimits(element(8_000_000))).not.toThrow();
        expect(isXmlWithinLimits(element(8_000_000))).toBe(false);
    });

    it('accepts legal numeric character references and rejects illegal code points', () => {
        expect(isXmlWithinLimits('<Root value="&#x1F600;&#9;&#10;&#13;"/>')).toBe(true);
        for (const reference of ['&#0;', '&#xD800;', '&#x110000;', '&#1114112;', `&#${'9'.repeat(100)};`]) {
            expect(isXmlWithinLimits(`<Root value="${reference}"/>`)).toBe(false);
        }
        expect(isXmlWithinLimits(`<Root value="&#${'9'.repeat(100_000)};"/>`)).toBe(false);
    });

    it('rejects illegal raw XML characters in every content context', () => {
        expect(isXmlWithinLimits('<Root value="😀">😀<!-- 😀 --><![CDATA[😀]]></Root>')).toBe(true);
        for (const character of ['\0', '\u0001', '\u0008', '\u000b', '\u000c', '\u001f', '\ud800', '\ufffe', '\uffff']) {
            for (const xml of [
                `<Root value="${character}"/>`,
                `<Root>${character}</Root>`,
                `<Root><!-- ${character} --></Root>`,
                `<Root><![CDATA[${character}]]></Root>`,
            ]) expect(isXmlWithinLimits(xml)).toBe(false);
        }
    });

    it.each([
        '',
        '<Root>',
        '</Root>',
        '<!DOCTYPE Root><Root />',
        '<Root><!-- unterminated</Root>',
        '<Root><![CDATA[unterminated</Root>',
        '<a></b>',
        '<a/><b/>',
        'junk<a/>junk',
        '<a x="1" x="2"/>',
        '<root>&bogus;</root>',
        '<root a="&bogus;"/>',
        '<root><!--x--y--></root>',
        '<root xmlns:x=""><x:a/></root>',
    ])('rejects malformed or unsafe input %j', xml => {
        expect(isXmlWithinLimits(xml)).toBe(false);
    });
});
