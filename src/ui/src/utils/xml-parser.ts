import {
    appendXmlPath,
    htmlXpathSegment,
    inspectPageSource,
    MAX_XML_DEPTH,
    MAX_XML_ELEMENTS,
} from '../../../core/xml/xml-limits';
import {
    normalizeParsedElement,
    resolveSourcePlatform,
    type HtmlElementContext,
} from '../../../core/xml/normalize-element';
import type { Interaction, ParsedElement } from '../types';

export type ParsedXmlDocument = {
    doc: Document;
    elements: ParsedElement[];
};

export function parseXmlDocument(xmlString: string): ParsedXmlDocument {
    const parser = new DOMParser();
    const inspection = inspectPageSource(xmlString);
    const html = inspection?.format === 'html';
    const doc = parser.parseFromString(inspection ? xmlString : '', html ? 'text/html' : 'text/xml');
    const elements: ParsedElement[] = [];
    let generatedPathChars = 0;

    if (
        !inspection
        || (
            !html
            &&
            doc.documentElement.localName === 'parsererror'
            && doc.documentElement.namespaceURI === 'http://www.mozilla.org/newlayout/xml/parsererror.xml'
        )
    ) {
        return { doc, elements };
    }

    const htmlContext: HtmlElementContext | undefined = html
        ? { formDisabled: false, hidden: false, inert: false }
        : undefined;
    const stack: Array<{
        node: Element;
        xpath: string;
        siblingIndex: number;
        depth: number;
        htmlContext: HtmlElementContext | undefined;
    }> = [
        { node: doc.documentElement, xpath: '', siblingIndex: 1, depth: 1, htmlContext },
    ];

    while (stack.length > 0) {
        const entry = stack.pop();
        if (!entry) break;
        const { node, xpath, siblingIndex, depth, htmlContext: context } = entry;
        if (elements.length >= MAX_XML_ELEMENTS) return { doc, elements: [] };
        const attributes = Object.fromEntries(
            Array.from(node.attributes, attribute => [attribute.name, attribute.value]),
        );
        const tag = html ? node.localName : node.tagName;
        const segment = html ? htmlXpathSegment(tag, node.namespaceURI) : tag;
        const path = appendXmlPath(xpath, segment, siblingIndex, generatedPathChars);
        if (!path) return { doc, elements: [] };
        const currentXpath = path.path;
        generatedPathChars = path.generatedChars;
        elements.push({
            ...normalizeParsedElement(tag, attributes, currentXpath, elements.length, context),
            node,
        });

        if (depth >= MAX_XML_DEPTH) {
            if (node.children.length > 0) return { doc, elements: [] };
            continue;
        }

        const childCounts = new Map<string, number>();
        const fieldsetDisabled = context !== undefined
            && tag === 'fieldset'
            && attributes.disabled !== undefined;
        let firstLegendSeen = false;
        const children = Array.from(node.children, child => {
            const childTag = html ? child.localName : child.tagName;
            const childSegment = html
                ? htmlXpathSegment(childTag, child.namespaceURI)
                : childTag;
            const childIndex = (childCounts.get(childSegment) ?? 0) + 1;
            childCounts.set(childSegment, childIndex);
            const firstLegend = fieldsetDisabled && childTag === 'legend' && !firstLegendSeen;
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
            return {
                node: child,
                xpath: currentXpath,
                siblingIndex: childIndex,
                depth: depth + 1,
                htmlContext: childHtmlContext,
            };
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
