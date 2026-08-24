import { appendXmlPath, isXmlWithinLimits, MAX_XML_DEPTH, MAX_XML_ELEMENTS } from '../../../core/xml/xml-limits';
import { normalizeParsedElement, resolveSourcePlatform } from '../../../core/xml/normalize-element';
import type { Interaction, ParsedElement } from '../types';

export type ParsedXmlDocument = {
    doc: Document;
    elements: ParsedElement[];
};

export function parseXmlDocument(xmlString: string): ParsedXmlDocument {
    const parser = new DOMParser();
    const withinLimits = isXmlWithinLimits(xmlString);
    const doc = parser.parseFromString(withinLimits ? xmlString : '', 'text/xml');
    const elements: ParsedElement[] = [];
    let generatedPathChars = 0;

    if (
        !withinLimits
        || (
            doc.documentElement.localName === 'parsererror'
            && doc.documentElement.namespaceURI === 'http://www.mozilla.org/newlayout/xml/parsererror.xml'
        )
    ) {
        return { doc, elements };
    }

    const stack: Array<{ node: Element; xpath: string; siblingIndex: number; depth: number }> = [
        { node: doc.documentElement, xpath: '', siblingIndex: 1, depth: 1 },
    ];

    while (stack.length > 0 && elements.length < MAX_XML_ELEMENTS) {
        const entry = stack.pop();
        if (!entry) break;
        const { node, xpath, siblingIndex, depth } = entry;
        const attributes = Object.fromEntries(
            Array.from(node.attributes, attribute => [attribute.name, attribute.value]),
        );
        const path = appendXmlPath(xpath, node.tagName, siblingIndex, generatedPathChars);
        if (!path) return { doc, elements: [] };
        const currentXpath = path.path;
        generatedPathChars = path.generatedChars;
        elements.push({
            ...normalizeParsedElement(node.tagName, attributes, currentXpath, elements.length),
            node,
        });

        if (depth >= MAX_XML_DEPTH) continue;

        const childCounts = new Map<string, number>();
        const children = Array.from(node.children, child => {
            const childIndex = (childCounts.get(child.tagName) ?? 0) + 1;
            childCounts.set(child.tagName, childIndex);
            return { node: child, xpath: currentXpath, siblingIndex: childIndex, depth: depth + 1 };
        });
        stack.push(...children.reverse());
    }

    resolveSourcePlatform(elements);

    return { doc, elements };
}

export function parseXmlSource(xmlString: string): ParsedElement[] {
    return parseXmlDocument(xmlString).elements;
}

export function getParsedElements(interaction: Interaction): ParsedElement[] {
    return interaction.source ? parseXmlSource(interaction.source) : [];
}
