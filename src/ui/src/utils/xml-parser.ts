import type { Interaction, ParsedElement } from '../types';

export type ParsedXmlDocument = {
    doc: Document;
    elements: ParsedElement[];
};

/**
 * Parse XML into both the DOM document and the flat element list. Keeping the
 * document around lets callers evaluate XPath against the same nodes stored on
 * each ParsedElement, so matches can be compared by identity instead of
 * deep-comparing nodes across two separately parsed documents.
 */
export function parseXmlDocument(xmlString: string): ParsedXmlDocument {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'text/xml');
    const elements: ParsedElement[] = [];

    function traverse(node: Element, xpath = '', index = 0) {
        if (node.nodeType !== 1) return;

        const type = node.getAttribute('type') || node.tagName;
        const x = parseInt(node.getAttribute('x') || '0');
        const y = parseInt(node.getAttribute('y') || '0');
        const width = parseInt(node.getAttribute('width') || '0');
        const height = parseInt(node.getAttribute('height') || '0');

        const currentXpath = xpath + '/' + type + '[' + (index + 1) + ']';

        elements.push({
            type,
            name: node.getAttribute('name') || '',
            label: node.getAttribute('label') || '',
            value: node.getAttribute('value') || '',
            enabled: node.getAttribute('enabled') === 'true',
            visible:
                node.getAttribute('visible') !== 'false' &&
                node.getAttribute('displayed') !== 'false',
            accessible: node.getAttribute('accessible') === 'true',
            x, y, width, height,
            xpath: currentXpath,
            node
        });

        const childCounts: Record<string, number> = {};
        for (const child of Array.from(node.children)) {
            const childType = child.getAttribute('type') || child.tagName;
            childCounts[childType] = (childCounts[childType] || 0);
            traverse(child as Element, currentXpath, childCounts[childType]);
            childCounts[childType]++;
        }
    }

    if (doc.documentElement) {
        traverse(doc.documentElement);
    }
    return { doc, elements };
}

export function parseXmlSource(xmlString: string): ParsedElement[] {
    return parseXmlDocument(xmlString).elements;
}

const parseCache = new WeakMap<Interaction, ParsedElement[]>();

/**
 * Parse an interaction's XML source, caching per interaction object so
 * repeated lookups (e.g. stability checks across many snapshots) don't
 * re-parse the same source on every recomputation.
 */
export function getParsedElements(interaction: Interaction): ParsedElement[] {
    if (!interaction.source) return [];

    let elements = parseCache.get(interaction);
    if (!elements) {
        elements = parseXmlSource(interaction.source);
        parseCache.set(interaction, elements);
    }
    return elements;
}
