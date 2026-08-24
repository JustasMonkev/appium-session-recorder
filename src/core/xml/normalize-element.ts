import type { ParsedElement, Platform } from '../types';

function booleanValue(value: string | undefined): boolean {
    return value === 'true' || value === '1';
}

function numberValue(value: string | undefined): number {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function visibleValue(value: string | undefined): boolean {
    return value === undefined || (value !== 'false' && value !== '0');
}

function androidBounds(value: string | undefined) {
    const match = value?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!match) return { x: 0, y: 0, width: 0, height: 0 };
    const [x1, y1, x2, y2] = match.slice(1).map(Number);
    return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

function platformFor(type: string, attributes: Record<string, string>): Platform {
    if (type.startsWith('XCUIElementType')) return 'ios';
    if (
        type.startsWith('android.')
        || attributes.class?.startsWith('android.')
        || attributes['resource-id']
        || attributes['content-desc']
    ) return 'android';
    return 'unknown';
}

export function normalizeParsedElement(
    tag: string,
    attributes: Record<string, string>,
    xpath: string,
    index: number,
): ParsedElement {
    const type = attributes.type || attributes.class || tag;
    const platform = platformFor(type, attributes);
    const bounds = androidBounds(attributes.bounds);
    const resourceId = attributes['resource-id'] || attributes.resourceId || attributes.id || '';
    const contentDesc = attributes['content-desc'] || attributes.contentDesc || '';
    const value = attributes.value || '';
    return {
        elementRef: `${platform}:${xpath}`,
        index,
        platform,
        type,
        xpath,
        name: attributes.name || contentDesc || resourceId,
        label: attributes.label || attributes.text || contentDesc,
        value,
        text: attributes.text || value,
        resourceId,
        contentDesc,
        enabled: booleanValue(attributes.enabled),
        visible: visibleValue(attributes.visible) && visibleValue(attributes.displayed),
        accessible: booleanValue(attributes.accessible),
        clickable: booleanValue(attributes.clickable),
        x: attributes.x === undefined ? bounds.x : numberValue(attributes.x),
        y: attributes.y === undefined ? bounds.y : numberValue(attributes.y),
        width: attributes.width === undefined ? bounds.width : numberValue(attributes.width),
        height: attributes.height === undefined ? bounds.height : numberValue(attributes.height),
        attributes,
    };
}

export function resolveSourcePlatform(elements: ParsedElement[]): Platform {
    const platform = elements.some(element => element.platform === 'ios')
        ? 'ios'
        : elements.some(element => element.platform === 'android') ? 'android' : 'unknown';
    if (platform === 'unknown') return platform;
    for (const element of elements) {
        if (element.platform !== 'unknown') continue;
        element.platform = platform;
        element.elementRef = `${platform}:${element.xpath}`;
    }
    return platform;
}
