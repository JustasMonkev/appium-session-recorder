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

export type ElementMatcher = (element: ParsedElement) => boolean;

const neverMatches: ElementMatcher = () => false;

function unescapeQuoted(value: string): string {
    return value.replace(
        /\\(?:u([\da-fA-F]{4})|([\\"'`nrt]))/g,
        (_escape, hexadecimal: string | undefined, character: string | undefined) => {
            if (hexadecimal) return String.fromCharCode(Number.parseInt(hexadecimal, 16));
            if (character === 'n') return '\n';
            if (character === 'r') return '\r';
            if (character === 't') return '\t';
            return character ?? '';
        },
    );
}

function compileIosPredicate(predicate: string): ElementMatcher {
    const equalsMatch = predicate.match(/^\s*(name|label|type)\s*==\s*(["'])((?:\\.|(?!\2)[\s\S])*)\2\s*$/i);
    if (equalsMatch) {
        const [, field, , encoded] = equalsMatch;
        const expected = unescapeQuoted(encoded);
        if (field.toLowerCase() === 'name') return element => element.name === expected;
        if (field.toLowerCase() === 'label') return element => element.label === expected;
        return element => element.type === expected;
    }

    const containsMatch = predicate.match(/^\s*(name|label|type)\s*CONTAINS\s*(["'])((?:\\.|(?!\2)[\s\S])*)\2\s*$/i);
    if (containsMatch) {
        const [, field, , encoded] = containsMatch;
        const expected = unescapeQuoted(encoded);
        if (field.toLowerCase() === 'name') return element => element.name.includes(expected);
        if (field.toLowerCase() === 'label') return element => element.label.includes(expected);
        return element => element.type.includes(expected);
    }

    return neverMatches;
}

function compileIosClassChain(classChain: string): ElementMatcher {
    const classChainMatch = classChain.match(/^\*\*\/([A-Za-z_][\w.:-]*)(?:\[`((?:\\.|[^`\\])*)`\])?$/);
    if (!classChainMatch) return neverMatches;

    const targetType = classChainMatch[1];
    const predicate = classChainMatch[2];
    const predicateMatcher = predicate ? compileIosPredicate(predicate) : null;

    return element => {
        if (element.type !== targetType) return false;
        return predicateMatcher ? predicateMatcher(element) : true;
    };
}

function compileAndroidUiAutomator(value: string): ElementMatcher {
    if (!/^new UiSelector\(\)(?:\.(?:resourceId|description|text|className)\("(?:\\.|[^"\\])*"\))+$/.test(value)) {
        return neverMatches;
    }
    const calls = [...value.matchAll(/\.(\w+)\("((?:\\.|[^"])*)"\)/g)]
        .map(([, method, expected]) => ({ method, expected: unescapeQuoted(expected) }));
    if (calls.length === 0) return neverMatches;

    return element => calls.every(({ method, expected }) => {
        if (method === 'resourceId') return element.resourceId === expected;
        if (method === 'description') return element.contentDesc === expected;
        if (method === 'text') return element.text === expected;
        if (method === 'className') return element.type === expected;
        return false;
    });
}

function compileSimpleXPath(xpath: string): ElementMatcher {
    const descendantNode = xpath.match(/^\/\/([^/*\[]+)/)?.[1];
    const attrConditions = [
        ...[...xpath.matchAll(/@([\w-]+)="([^"]*)"/g)].map(([, attribute, expected]) => ({ attribute, expected })),
        ...[...xpath.matchAll(/@([\w-]+)='([^']*)'/g)].map(([, attribute, expected]) => ({ attribute, expected })),
    ];

    return element => {
        if (xpath === element.xpath) return true;
        if (attrConditions.length === 0) return false;
        if (descendantNode) {
            const actualNode = element.xpath.match(/\/([^/[]+)\[\d+\]$/)?.[1];
            if (actualNode !== descendantNode) return false;
        }

        return attrConditions.every(({ attribute, expected }) => element.attributes[attribute] === expected);
    };
}

export function compileCandidateMatcher(candidate: SelectorCandidate): ElementMatcher {
    switch (candidate.strategy) {
        case 'id':
            return candidate.platform === 'ios'
                ? element => element.name === candidate.value
                : element => element.resourceId === candidate.value;
        case 'accessibility id':
            return candidate.platform === 'android'
                ? element => element.contentDesc === candidate.value
                : element => (
                element.name === candidate.value ||
                element.label === candidate.value ||
                element.contentDesc === candidate.value
            );
        case 'class name':
            return element => element.type === candidate.value;
        case 'xpath':
            return compileSimpleXPath(candidate.value);
        case '-ios predicate string':
            return compileIosPredicate(candidate.value);
        case '-ios class chain':
            return compileIosClassChain(candidate.value);
        case '-android uiautomator':
            return compileAndroidUiAutomator(candidate.value);
        default:
            return neverMatches;
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

        const matches = compileCandidateMatcher(candidate);
        let matchCount = 0;
        for (const element of allElements) {
            if (matches(element)) matchCount++;
        }

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
            score: Math.round(score),
            matchCount,
            reasons,
        };
    });

    return ranked.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.matchCount !== b.matchCount) return a.matchCount - b.matchCount;
        return a.value.localeCompare(b.value);
    }).map(selector => ({
        ...selector,
        score: Math.max(0, Math.min(100, selector.score)),
    }));
}
