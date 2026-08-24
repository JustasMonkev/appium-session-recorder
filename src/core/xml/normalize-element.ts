import type { ParsedElement, Platform } from '../types';

const HTML_ACTIONABLE_ELEMENTS = new Set(['button', 'input', 'select', 'textarea']);
const HTML_DISABLEABLE_ELEMENTS = new Set([
    'button', 'fieldset', 'input', 'optgroup', 'option', 'select', 'textarea',
]);

export type HtmlElementContext = { formDisabled: boolean; hidden: boolean; inert: boolean };

export function htmlClassTokens(value: string | undefined): string[] {
    return value?.split(/[\t\n\f\r ]+/).filter(Boolean) ?? [];
}

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
    htmlContext?: HtmlElementContext,
): ParsedElement {
    const html = htmlContext !== undefined;
    const type = html ? tag : attributes.type || attributes.class || tag;
    const platform = html ? 'unknown' : platformFor(type, attributes);
    const bounds = androidBounds(attributes.bounds);
    const resourceId = html
        ? attributes.id || ''
        : attributes['resource-id'] || attributes.resourceId || attributes.id || '';
    const contentDesc = html ? '' : attributes['content-desc'] || attributes.contentDesc || '';
    const value = attributes.value || '';
    const htmlVisible = !htmlContext?.hidden
        && attributes.hidden === undefined
        && !(tag === 'input' && attributes.type?.toLowerCase() === 'hidden');
    const htmlEnabled = !htmlContext?.inert
        && (
            !HTML_DISABLEABLE_ELEMENTS.has(tag)
            || (!htmlContext?.formDisabled && attributes.disabled === undefined)
        )
        && attributes.inert === undefined;
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
        enabled: html ? htmlEnabled : booleanValue(attributes.enabled),
        visible: visibleValue(attributes.visible)
            && visibleValue(attributes.displayed)
            && (!html || htmlVisible),
        accessible: booleanValue(attributes.accessible),
        clickable: html
            ? htmlVisible && htmlEnabled && (
                HTML_ACTIONABLE_ELEMENTS.has(tag) || (tag === 'a' && attributes.href !== undefined)
            )
            : booleanValue(attributes.clickable),
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
