import type { ParsedElement, Platform, SelectorCandidate } from '../types';

function pushUnique(candidates: SelectorCandidate[], candidate: SelectorCandidate): void {
    if (!candidate.value) return;
    if (candidates.some(existing => existing.strategy === candidate.strategy && existing.value === candidate.value)) {
        return;
    }
    candidates.push(candidate);
}

function escapeDoubleQuoted(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function generateSelectorCandidates(element: ParsedElement): SelectorCandidate[] {
    const candidates: SelectorCandidate[] = [];
    const platform: Platform = element.platform;

    const primaryAccessibility = element.name || element.label || element.contentDesc;
    if (primaryAccessibility) {
        pushUnique(candidates, {
            strategy: 'accessibility id',
            value: primaryAccessibility,
            platform,
        });
    }

    if (platform === 'ios') {
        if (element.label && element.label !== primaryAccessibility) {
            pushUnique(candidates, {
                strategy: 'accessibility id',
                value: element.label,
                platform,
            });
        }

        if (element.name) {
            pushUnique(candidates, {
                strategy: '-ios predicate string',
                value: `name == "${escapeDoubleQuoted(element.name)}"`,
                platform,
            });
            pushUnique(candidates, {
                strategy: '-ios class chain',
                value: `**/${element.type}[\`name == "${escapeDoubleQuoted(element.name)}"\`]`,
                platform,
            });
        }

        if (element.label) {
            pushUnique(candidates, {
                strategy: '-ios predicate string',
                value: `label == "${escapeDoubleQuoted(element.label)}"`,
                platform,
            });
        }
    }

    if (platform === 'android') {
        if (element.resourceId) {
            pushUnique(candidates, {
                strategy: 'id',
                value: element.resourceId,
                platform,
            });
            pushUnique(candidates, {
                strategy: '-android uiautomator',
                value: `new UiSelector().resourceId("${escapeDoubleQuoted(element.resourceId)}")`,
                platform,
            });
        }

        if (element.contentDesc) {
            pushUnique(candidates, {
                strategy: 'accessibility id',
                value: element.contentDesc,
                platform,
            });
            pushUnique(candidates, {
                strategy: '-android uiautomator',
                value: `new UiSelector().description("${escapeDoubleQuoted(element.contentDesc)}")`,
                platform,
            });
        }

        if (element.text) {
            pushUnique(candidates, {
                strategy: '-android uiautomator',
                value: `new UiSelector().text("${escapeDoubleQuoted(element.text)}")`,
                platform,
            });
        }
    }

    if (element.type && (element.name || element.label || element.text)) {
        const attrName = element.platform === 'android' ? 'text' : 'name';
        const attrValue = element.platform === 'android' ? element.text || element.label : element.name || element.label;
        if (attrValue) {
            pushUnique(candidates, {
                strategy: 'xpath',
                value: `//*[@type="${escapeDoubleQuoted(element.type)}" and @${attrName}="${escapeDoubleQuoted(attrValue)}"]`,
                platform: 'generic',
            });
        }
    }

    pushUnique(candidates, { strategy: 'xpath', value: element.xpath, platform: 'generic' });
    pushUnique(candidates, { strategy: 'class name', value: element.type, platform: 'generic' });

    return candidates;
}

export type LegacyLocatorInput = {
    type: string;
    name: string;
    label: string;
    xpath: string;
};

export function generateLegacyLocators(element: LegacyLocatorInput): SelectorCandidate[] {
    const locators: SelectorCandidate[] = [];

    if (element.name) {
        locators.push({ strategy: 'accessibility id', value: element.name, platform: 'ios' });
    }
    if (element.label && element.label !== element.name) {
        locators.push({ strategy: 'accessibility id', value: element.label, platform: 'ios' });
    }
    locators.push({ strategy: 'xpath', value: element.xpath, platform: 'generic' });
    locators.push({ strategy: 'class name', value: element.type, platform: 'generic' });

    if (element.name) {
        locators.push({
            strategy: '-ios predicate string',
            value: `name == "${escapeDoubleQuoted(element.name)}"`,
            platform: 'ios',
        });
    }
    if (element.label) {
        locators.push({
            strategy: '-ios predicate string',
            value: `label == "${escapeDoubleQuoted(element.label)}"`,
            platform: 'ios',
        });
    }
    if (element.name) {
        locators.push({
            strategy: '-ios class chain',
            value: `**/${element.type}[\`name == "${escapeDoubleQuoted(element.name)}"\`]`,
            platform: 'ios',
        });
    }

    return locators;
}
