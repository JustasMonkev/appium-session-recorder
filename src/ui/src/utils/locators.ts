import type { ParsedElement, Locator } from '../types';

export function generateLocators(element: ParsedElement): Locator[] {
    const locators: Locator[] = [];

    if (element.name) {
        locators.push({ strategy: 'accessibility id', value: element.name });
    }
    if (element.label && element.label !== element.name) {
        locators.push({ strategy: 'accessibility id', value: element.label });
    }
    locators.push({ strategy: 'xpath', value: element.xpath });
    locators.push({ strategy: 'class name', value: element.type });

    if (element.name) {
        locators.push({
            strategy: '-ios predicate string',
            value: `name == "${element.name}"`
        });
    }
    if (element.label) {
        locators.push({
            strategy: '-ios predicate string',
            value: `label == "${element.label}"`
        });
    }
    if (element.name) {
        locators.push({
            strategy: '-ios class chain',
            value: `**/${element.type}[\`name == "${element.name}"\`]`
        });
    }

    return locators;
}
