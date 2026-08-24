import type { ParsedElement, Platform, SelectorCandidate } from '../types';

function pushUnique(candidates: SelectorCandidate[], candidate: SelectorCandidate): void {
    if (!candidate.value) return;
    if (candidates.some(existing => existing.strategy === candidate.strategy && existing.value === candidate.value)) {
        return;
    }
    candidates.push(candidate);
}

function escapeDoubleQuoted(value: string): string {
    return Array.from(value, character => {
        if (character === '\\') return '\\\\';
        if (character === '"') return '\\"';
        if (character === '\n') return '\\n';
        if (character === '\r') return '\\r';
        if (character === '\t') return '\\t';
        const codePoint = character.codePointAt(0)!;
        return codePoint < 0x20 || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029
            ? `\\u${codePoint.toString(16).padStart(4, '0')}`
            : character;
    }).join('');
}

function escapeClassChainValue(value: string): string {
    return escapeDoubleQuoted(value).replace(/`/g, '\\`');
}

function xpathLiteral(value: string): string | undefined {
    if (!value.includes('"')) return `"${value}"`;
    if (!value.includes("'")) return `'${value}'`;
    return undefined;
}

function actualAttribute(
    element: ParsedElement,
    names: readonly string[],
    value: string,
): [string, string] | undefined {
    if (!value) return undefined;
    const name = names.find(candidate => element.attributes[candidate] === value);
    return name ? [name, value] : undefined;
}

function xpathNodeConstraint(element: ParsedElement): { node: string; condition?: string } {
    const typeLiteral = xpathLiteral(element.type);
    if (typeLiteral && element.attributes.type === element.type) {
        return { node: '*', condition: `@type=${typeLiteral}` };
    }
    if (typeLiteral && element.attributes.class === element.type) {
        return { node: '*', condition: `@class=${typeLiteral}` };
    }
    return { node: element.xpath.match(/\/([^/[]+)\[\d+\]$/)?.[1] ?? '*' };
}

export function generateSelectorCandidates(element: ParsedElement): SelectorCandidate[] {
    const candidates: SelectorCandidate[] = [];
    const platform: Platform = element.platform;

    const primaryAccessibility = platform === 'android'
        ? element.contentDesc
        : element.name || element.label || element.contentDesc;
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
                value: `**/${element.type}[\`name == "${escapeClassChainValue(element.name)}"\`]`,
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

    if (element.type) {
        const attribute = platform === 'android'
            ? actualAttribute(element, ['resource-id', 'resourceId', 'id'], element.resourceId)
                ?? actualAttribute(element, ['content-desc', 'contentDesc'], element.contentDesc)
                ?? actualAttribute(element, ['text', 'value', 'label'], element.text || element.label)
            : actualAttribute(element, ['name'], element.name)
                ?? actualAttribute(element, ['label'], element.label);
        const valueLiteral = xpathLiteral(attribute?.[1] ?? '');
        if (attribute && valueLiteral) {
            const { node, condition } = xpathNodeConstraint(element);
            const conditions = [condition, `@${attribute[0]}=${valueLiteral}`].filter(Boolean).join(' and ');
            pushUnique(candidates, {
                strategy: 'xpath',
                value: `//${node}[${conditions}]`,
                platform: 'generic',
            });
        }
    }

    pushUnique(candidates, { strategy: 'xpath', value: element.xpath, platform: 'generic' });
    pushUnique(candidates, { strategy: 'class name', value: element.type, platform: 'generic' });

    return candidates;
}
