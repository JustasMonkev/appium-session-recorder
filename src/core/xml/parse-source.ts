import { XMLParser } from 'fast-xml-parser';
import type { ParsedElement, ParsedSource } from '../types';
import { appendXmlPath, isXmlWithinLimits, MAX_XML_DEPTH, MAX_XML_ELEMENTS } from './xml-limits';
import { normalizeParsedElement, resolveSourcePlatform } from './normalize-element';

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    textNodeName: '#text',
    preserveOrder: true,
    processEntities: false,
    transformTagName: protectXmlName,
    transformAttributeName: protectXmlName,
});

const PROTECTED_NAME_PREFIX = '\0asr:';
const CRITICAL_XML_NAMES = new Set([
    '__proto__',
    'constructor',
    'prototype',
    'hasOwnProperty',
    'toString',
    'valueOf',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
]);

function protectXmlName(name: string): string {
    if (name.startsWith(PROTECTED_NAME_PREFIX) || !CRITICAL_XML_NAMES.has(name)) return name;
    return PROTECTED_NAME_PREFIX + Array.from(name, character => character.codePointAt(0)!.toString(16)).join('_');
}

function restoreXmlName(name: string): string {
    if (!name.startsWith(PROTECTED_NAME_PREFIX)) return name;
    const encoded = name.slice(PROTECTED_NAME_PREFIX.length);
    if (!/^[\da-f]+(?:_[\da-f]+)*$/i.test(encoded)) return name;
    return encoded.split('_').map(codePoint => String.fromCodePoint(Number.parseInt(codePoint, 16))).join('');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    // SAFETY: the runtime guard above narrows value to a non-array object with string-key access.
    return value as Record<string, unknown>;
}

function normalizeXmlAttribute(value: string): string {
    const whitespaceNormalized = value.replace(/[\t\n\r]/g, ' ');
    return whitespaceNormalized.replace(
        /&(?:#(\d+)|#x([\da-fA-F]+)|(amp|lt|gt|quot|apos));/g,
        (reference, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
            if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
            if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
            if (name === 'amp') return '&';
            if (name === 'lt') return '<';
            if (name === 'gt') return '>';
            if (name === 'quot') return '"';
            if (name === 'apos') return "'";
            return reference;
        },
    );
}

function xmlElement(value: unknown) {
    const entry = asRecord(value);
    const rawTag = entry && Object.keys(entry).find(key => (
        key !== ':@' && !key.startsWith('#') && !key.startsWith('?') && !key.startsWith('!')
    ));
    const children = rawTag && entry?.[rawTag];
    if (!entry || !rawTag || !Array.isArray(children)) return undefined;

    const attributes = Object.fromEntries(
        Object.entries(asRecord(entry[':@']) ?? {})
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            .map(([name, value]) => [restoreXmlName(name), normalizeXmlAttribute(value)]),
    );
    return { tag: restoreXmlName(rawTag), children, attributes };
}

export function parseSource(xmlString: string): ParsedSource {
    if (!isXmlWithinLimits(xmlString)) {
        return { platform: 'unknown', elements: [] };
    }

    let parsed: unknown;
    try {
        parsed = parser.parse(xmlString);
    } catch {
        return { platform: 'unknown', elements: [] };
    }
    if (!Array.isArray(parsed)) return { platform: 'unknown', elements: [] };

    const root = parsed.map(xmlElement).find(element => element !== undefined);
    if (!root) return { platform: 'unknown', elements: [] };

    const elements: ParsedElement[] = [];
    const stack = [{ element: root, xpath: '', siblingIndex: 1, depth: 1 }];
    let generatedPathChars = 0;

    while (stack.length > 0 && elements.length < MAX_XML_ELEMENTS) {
        const entry = stack.pop();
        if (!entry) break;
        const { element, xpath, siblingIndex, depth } = entry;
        const { tag, attributes } = element;
        const path = appendXmlPath(xpath, tag, siblingIndex, generatedPathChars);
        if (!path) return { platform: 'unknown', elements: [] };
        const currentXpath = path.path;
        generatedPathChars = path.generatedChars;
        elements.push(normalizeParsedElement(tag, attributes, currentXpath, elements.length));

        if (depth >= MAX_XML_DEPTH) continue;

        const childCounts = new Map<string, number>();
        const children = element.children.flatMap(child => {
            const parsedChild = xmlElement(child);
            if (!parsedChild) return [];
            const childIndex = (childCounts.get(parsedChild.tag) ?? 0) + 1;
            childCounts.set(parsedChild.tag, childIndex);
            return [{
                element: parsedChild,
                xpath: currentXpath,
                siblingIndex: childIndex,
                depth: depth + 1,
            }];
        });
        stack.push(...children.reverse());
    }

    return { platform: resolveSourcePlatform(elements), elements };
}
