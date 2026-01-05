import type { ParsedElement } from '../types';

export function parseXmlSource(xmlString: string): ParsedElement[] {
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
            visible: node.getAttribute('visible') === 'true',
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
    return elements;
}
