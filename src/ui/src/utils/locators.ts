import { generateLegacyLocators } from '../../../core/selectors/generate-candidates';
import type { ParsedElement, Locator } from '../types';

export function generateLocators(element: ParsedElement): Locator[] {
    return generateLegacyLocators({
        type: element.type,
        name: element.name,
        label: element.label,
        xpath: element.xpath,
    }).map(locator => ({
        strategy: locator.strategy,
        value: locator.value,
    }));
}
