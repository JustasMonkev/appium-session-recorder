import type { ParsedElement, RankedSelector, SelectorCandidate, SelectorReason, SelectorStrategy } from '../types';

const baseScoreByStrategy: Record<SelectorStrategy, number> = {
    id: 100,
    'accessibility id': 95,
    '-ios predicate string': 90,
    '-ios class chain': 85,
    '-android uiautomator': 85,
    xpath: 70,
    'class name': 55,
};

function isDynamicValue(value: string): boolean {
    if (/(?:^|[^a-zA-Z])\d{5,}(?:$|[^a-zA-Z])/.test(value)) return true;
    if (/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/.test(value)) {
        return true;
    }
    if (/autogen|generated|tmp|temp|anonymous/i.test(value)) return true;
    return false;
}

function xpathFragilityPenalty(xpath: string): number {
    if (!xpath.startsWith('/')) return 0;

    const depth = xpath.split('/').filter(Boolean).length;
    const indexCount = (xpath.match(/\[\d+\]/g) || []).length;

    let penalty = 0;
    if (depth > 5) penalty += 8;
    if (indexCount > 3) penalty += 8;

    return penalty;
}

function valueEquals(value: string, expected: string): boolean {
    return value === expected;
}

function matchIosPredicate(element: ParsedElement, predicate: string): boolean {
    const equalsMatch = predicate.match(/(name|label|type)\s*==\s*['"](.+?)['"]/i);
    if (equalsMatch) {
        const [, field, expected] = equalsMatch;
        if (field === 'name') return valueEquals(element.name, expected);
        if (field === 'label') return valueEquals(element.label, expected);
        return valueEquals(element.type, expected);
    }

    const containsMatch = predicate.match(/(name|label|type)\s*CONTAINS\s*['"](.+?)['"]/i);
    if (containsMatch) {
        const [, field, expected] = containsMatch;
        if (field === 'name') return element.name.includes(expected);
        if (field === 'label') return element.label.includes(expected);
        return element.type.includes(expected);
    }

    return false;
}

function matchIosClassChain(element: ParsedElement, classChain: string): boolean {
    const classChainMatch = classChain.match(/\*\*\/(\w+)(?:\[`(.+?)`\])?/);
    if (!classChainMatch) return false;

    const targetType = classChainMatch[1];
    const predicate = classChainMatch[2];
    if (element.type !== targetType) return false;

    if (!predicate) return true;
    return matchIosPredicate(element, predicate);
}

function matchAndroidUiAutomator(element: ParsedElement, value: string): boolean {
    const matches = [...value.matchAll(/\.(\w+)\("(.+?)"\)/g)];
    if (matches.length === 0) return false;

    return matches.every(([, method, expected]) => {
        if (method === 'resourceId') return element.resourceId === expected;
        if (method === 'description') return element.contentDesc === expected;
        if (method === 'text') return element.text === expected || element.label === expected;
        if (method === 'className') return element.type === expected;
        return false;
    });
}

function matchSimpleXPath(element: ParsedElement, xpath: string): boolean {
    if (xpath === element.xpath) return true;

    const attrMatches = [...xpath.matchAll(/@(\w+)="([^"]+)"/g)];
    if (attrMatches.length === 0) return false;

    return attrMatches.every(([, attribute, expected]) => {
        if (attribute === 'type') return element.type === expected;
        if (attribute === 'name') return element.name === expected;
        if (attribute === 'label') return element.label === expected;
        if (attribute === 'text') return element.text === expected;
        if (attribute === 'resource-id') return element.resourceId === expected;
        if (attribute === 'content-desc') return element.contentDesc === expected;
        return element.attributes[attribute] === expected;
    });
}

function candidateMatchesElement(candidate: SelectorCandidate, element: ParsedElement): boolean {
    switch (candidate.strategy) {
        case 'id':
            return element.resourceId === candidate.value;
        case 'accessibility id':
            return (
                element.name === candidate.value ||
                element.label === candidate.value ||
                element.contentDesc === candidate.value
            );
        case 'class name':
            return element.type === candidate.value;
        case 'xpath':
            return matchSimpleXPath(element, candidate.value);
        case '-ios predicate string':
            return matchIosPredicate(element, candidate.value);
        case '-ios class chain':
            return matchIosClassChain(element, candidate.value);
        case '-android uiautomator':
            return matchAndroidUiAutomator(element, candidate.value);
        default:
            return false;
    }
}

export function rankSelectorCandidates(
    target: ParsedElement,
    allElements: ParsedElement[],
    candidates: SelectorCandidate[],
): RankedSelector[] {
    const ranked = candidates.map((candidate) => {
        const reasons: SelectorReason[] = ['BASE_STRATEGY_PRIORITY'];
        let score = baseScoreByStrategy[candidate.strategy] ?? 50;

        const matchCount = allElements.filter(element => candidateMatchesElement(candidate, element)).length;

        if (matchCount === 1) {
            score += 25;
            reasons.push('UNIQUE_MATCH');
        } else if (matchCount > 1) {
            score -= 10;
            reasons.push('MULTIPLE_MATCHES');
        } else {
            score -= 40;
            reasons.push('NO_MATCH');
        }

        if (matchCount > 0) {
            score += 5;
            reasons.push('VALID_MATCH');
        }

        if (target.enabled && target.visible && (target.clickable || target.accessible)) {
            score += 8;
            reasons.push('ACTIONABLE_ELEMENT_BONUS');
        }

        if (isDynamicValue(candidate.value)) {
            score -= 18;
            reasons.push('DYNAMIC_TOKEN_PENALTY');
        }

        if (candidate.strategy === 'xpath') {
            const penalty = xpathFragilityPenalty(candidate.value);
            if (penalty > 0) {
                score -= penalty;
                reasons.push('FRAGILE_XPATH_PENALTY');
            }
        }

        return {
            ...candidate,
            score: Math.max(0, Math.min(100, Math.round(score))),
            matchCount,
            reasons,
        };
    });

    return ranked.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.matchCount !== b.matchCount) return a.matchCount - b.matchCount;
        return a.value.localeCompare(b.value);
    });
}
