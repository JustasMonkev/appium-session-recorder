import { XMLParser } from 'fast-xml-parser';
import { parse as parseHtml } from 'parse5';
import type { ParsedElement, ParsedSource } from '../types';
import { appendXmlPath, htmlXpathSegment, inspectPageSource, MAX_XML_DEPTH, MAX_XML_ELEMENTS } from './xml-limits';
import { normalizeParsedElement, resolveSourcePlatform, type HtmlElementContext } from './normalize-element';

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

type SourceElement = {
    tag: string;
    children: unknown[];
    attributes: Record<string, string>;
    namespace?: string;
};

function xmlElement(value: unknown): SourceElement | undefined {
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

function htmlElement(value: unknown): SourceElement | undefined {
    const entry = asRecord(value);
    if (!entry || typeof entry.tagName !== 'string' || !Array.isArray(entry.childNodes)) return undefined;
    const attributes = Object.fromEntries(entry.attrs instanceof Array
        ? entry.attrs.flatMap((value) => {
            const attribute = asRecord(value);
            if (!attribute || typeof attribute.name !== 'string' || typeof attribute.value !== 'string') return [];
            const name = typeof attribute.prefix === 'string'
                ? `${attribute.prefix}:${attribute.name}`
                : attribute.name;
            return [[name, attribute.value]];
        })
        : []);
    return {
        tag: entry.tagName,
        children: entry.childNodes,
        attributes,
        namespace: typeof entry.namespaceURI === 'string' ? entry.namespaceURI : undefined,
    };
}

type ElementReader = (value: unknown) => SourceElement | undefined;

export function parseSource(source: string): ParsedSource {
    const inspection = inspectPageSource(source);
    if (!inspection) return { platform: 'unknown', elements: [] };

    let roots: unknown[];
    let readElement: ElementReader;
    try {
        if (inspection.format === 'html') {
            roots = parseHtml(source, { scriptingEnabled: false }).childNodes;
            readElement = htmlElement;
        } else {
            const parsed = parser.parse(source);
            if (!Array.isArray(parsed)) return { platform: 'unknown', elements: [] };
            roots = parsed;
            readElement = xmlElement;
        }
    } catch {
        return { platform: 'unknown', elements: [] };
    }

    const root = roots.map(readElement).find(element => element !== undefined);
    if (!root) return { platform: 'unknown', elements: [] };

    const elements: ParsedElement[] = [];
    const htmlContext: HtmlElementContext | undefined = inspection.format === 'html'
        ? { formDisabled: false, hidden: false, inert: false }
        : undefined;
    const stack = [{ element: root, xpath: '', siblingIndex: 1, depth: 1, htmlContext }];
    let generatedPathChars = 0;

    while (stack.length > 0) {
        if (elements.length >= MAX_XML_ELEMENTS) return { platform: 'unknown', elements: [] };
        const entry = stack.pop();
        if (!entry) break;
        const { element, xpath, siblingIndex, depth, htmlContext: context } = entry;
        const { tag, attributes } = element;
        const segment = context ? htmlXpathSegment(tag, element.namespace) : tag;
        const path = appendXmlPath(xpath, segment, siblingIndex, generatedPathChars);
        if (!path) return { platform: 'unknown', elements: [] };
        const currentXpath = path.path;
        generatedPathChars = path.generatedChars;
        elements.push(normalizeParsedElement(
            tag,
            attributes,
            currentXpath,
            elements.length,
            context,
        ));

        if (depth >= MAX_XML_DEPTH) {
            if (element.children.some(child => readElement(child) !== undefined)) {
                return { platform: 'unknown', elements: [] };
            }
            continue;
        }

        const childCounts = new Map<string, number>();
        const fieldsetDisabled = context !== undefined
            && tag === 'fieldset'
            && attributes.disabled !== undefined;
        let firstLegendSeen = false;
        const children = element.children.flatMap(child => {
            const parsedChild = readElement(child);
            if (!parsedChild) return [];
            const childSegment = context
                ? htmlXpathSegment(parsedChild.tag, parsedChild.namespace)
                : parsedChild.tag;
            const childIndex = (childCounts.get(childSegment) ?? 0) + 1;
            childCounts.set(childSegment, childIndex);
            const firstLegend = fieldsetDisabled && parsedChild.tag === 'legend' && !firstLegendSeen;
            if (firstLegend) firstLegendSeen = true;
            const childHtmlContext = context && {
                formDisabled: context.formDisabled
                    || (fieldsetDisabled && !firstLegend)
                    || (
                        (tag === 'select' || tag === 'optgroup')
                        && attributes.disabled !== undefined
                    ),
                hidden: context.hidden || attributes.hidden !== undefined,
                inert: context.inert || attributes.inert !== undefined,
            };
            return [{
                element: parsedChild,
                xpath: currentXpath,
                siblingIndex: childIndex,
                depth: depth + 1,
                htmlContext: childHtmlContext,
            }];
        });
        stack.push(...children.reverse());
    }

    return { platform: resolveSourcePlatform(elements), elements };
}
