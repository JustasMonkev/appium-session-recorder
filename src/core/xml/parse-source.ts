import { XMLParser } from 'fast-xml-parser';
import type { ParsedElement, ParsedSource, Platform } from '../types';

type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    textNodeName: '#text',
    preserveOrder: false,
});

function asString(value: unknown): string {
    if (value === undefined || value === null) return '';
    return String(value);
}

function asBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    return asString(value).toLowerCase() === 'true' || asString(value) === '1';
}

function asNumber(value: unknown): number {
    const n = Number(asString(value));
    return Number.isFinite(n) ? n : 0;
}

function parseAndroidBounds(bounds: string): { x: number; y: number; width: number; height: number } {
    const match = bounds.match(/\[(\-?\d+),(\-?\d+)\]\[(\-?\d+),(\-?\d+)\]/);
    if (!match) {
        return { x: 0, y: 0, width: 0, height: 0 };
    }

    const x1 = Number(match[1]);
    const y1 = Number(match[2]);
    const x2 = Number(match[3]);
    const y2 = Number(match[4]);

    return {
        x: x1,
        y: y1,
        width: Math.max(0, x2 - x1),
        height: Math.max(0, y2 - y1),
    };
}

function detectPlatform(type: string, attrs: Record<string, string>): Platform {
    if (type.startsWith('XCUIElementType') || attrs.type?.startsWith('XCUIElementType')) {
        return 'ios';
    }

    if (
        type.startsWith('android.') ||
        attrs.class?.startsWith('android.') ||
        attrs['resource-id'] ||
        attrs['content-desc']
    ) {
        return 'android';
    }

    return 'unknown';
}

function extractAttributes(node: XmlNode): Record<string, string> {
    const attrs: Record<string, string> = {};

    for (const [key, value] of Object.entries(node)) {
        if (value === null || value === undefined || key === '#text') continue;
        if (Array.isArray(value)) continue;
        if (typeof value === 'object') continue;
        attrs[key] = String(value);
    }

    return attrs;
}

function extractChildren(node: XmlNode): Array<{ tag: string; child: XmlNode }> {
    const children: Array<{ tag: string; child: XmlNode }> = [];

    for (const [key, value] of Object.entries(node)) {
        if (key === '#text' || value === null || value === undefined) continue;

        if (Array.isArray(value)) {
            for (const item of value) {
                if (item && typeof item === 'object') {
                    children.push({ tag: key, child: item as XmlNode });
                }
            }
            continue;
        }

        if (typeof value === 'object') {
            children.push({ tag: key, child: value as XmlNode });
        }
    }

    return children;
}

function makeElementRef(platform: Platform, xpath: string): string {
    return `${platform}:${xpath}`;
}

export function parseSource(xmlString: string): ParsedSource {
    if (!xmlString || !xmlString.trim()) {
        return { platform: 'unknown', elements: [] };
    }

    let parsed: Record<string, unknown>;
    try {
        parsed = parser.parse(xmlString) as Record<string, unknown>;
    } catch {
        return { platform: 'unknown', elements: [] };
    }

    const rootEntry = Object.entries(parsed).find(([, value]) => value && typeof value === 'object');
    if (!rootEntry) {
        return { platform: 'unknown', elements: [] };
    }

    const [rootTag, rootNode] = rootEntry;
    const elements: ParsedElement[] = [];
    let nextIndex = 0;

    function visit(tag: string, node: XmlNode, parentXpath: string, siblingIndex: number): void {
        const attrs = extractAttributes(node);
        const type = attrs.type || attrs.class || tag;
        const xpath = `${parentXpath}/${type}[${siblingIndex}]`;

        const platform = detectPlatform(type, attrs);
        const bounds = attrs.bounds ? parseAndroidBounds(attrs.bounds) : undefined;

        const x = attrs.x !== undefined ? asNumber(attrs.x) : (bounds?.x ?? 0);
        const y = attrs.y !== undefined ? asNumber(attrs.y) : (bounds?.y ?? 0);
        const width = attrs.width !== undefined ? asNumber(attrs.width) : (bounds?.width ?? 0);
        const height = attrs.height !== undefined ? asNumber(attrs.height) : (bounds?.height ?? 0);

        const name = attrs.name || attrs['content-desc'] || attrs.resourceId || '';
        const label = attrs.label || attrs.text || attrs['content-desc'] || '';
        const value = attrs.value || '';
        const text = attrs.text || value || '';
        const resourceId = attrs['resource-id'] || attrs.resourceId || attrs.id || '';
        const contentDesc = attrs['content-desc'] || attrs.contentDesc || '';

        elements.push({
            elementRef: makeElementRef(platform, xpath),
            index: nextIndex++,
            platform,
            type,
            xpath,
            name,
            label,
            value,
            text,
            resourceId,
            contentDesc,
            enabled: asBoolean(attrs.enabled),
            visible: asBoolean(attrs.visible) || asBoolean(attrs.displayed),
            accessible: asBoolean(attrs.accessible),
            clickable: asBoolean(attrs.clickable),
            x,
            y,
            width,
            height,
            attributes: attrs,
        });

        const childCounters: Record<string, number> = {};
        const children = extractChildren(node);
        for (const { tag: childTag, child } of children) {
            const childType = asString((child as XmlNode).type || (child as XmlNode).class || childTag);
            childCounters[childType] = (childCounters[childType] || 0) + 1;
            visit(childTag, child, xpath, childCounters[childType]);
        }
    }

    visit(rootTag, rootNode as XmlNode, '', 1);

    const platform =
        elements.find(element => element.platform === 'ios')?.platform ||
        elements.find(element => element.platform === 'android')?.platform ||
        'unknown';

    const withResolvedPlatform = elements.map(element => ({
        ...element,
        platform: element.platform === 'unknown' ? platform : element.platform,
        elementRef: makeElementRef(element.platform === 'unknown' ? platform : element.platform, element.xpath),
    }));

    return {
        platform,
        elements: withResolvedPlatform,
    };
}
