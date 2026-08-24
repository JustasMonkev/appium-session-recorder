import { describe, it, expect } from 'vitest';
import { rankSelectorCandidates } from '../../src/core/selectors/score-candidates';
import { generateSelectorCandidates } from '../../src/core/selectors/generate-candidates';
import type { ParsedElement, SelectorCandidate } from '../../src/core/types';

function createElement(overrides: Partial<ParsedElement>): ParsedElement {
    const element: ParsedElement = {
        elementRef: 'ios:/XCUIElementTypeButton[1]',
        index: 0,
        platform: 'ios',
        type: 'XCUIElementTypeButton',
        xpath: '/XCUIElementTypeApplication[1]/XCUIElementTypeButton[1]',
        name: 'loginBtn',
        label: 'Log In',
        value: '',
        text: '',
        resourceId: '',
        contentDesc: '',
        enabled: true,
        visible: true,
        accessible: true,
        clickable: true,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        attributes: {},
        ...overrides,
    };
    if (!overrides.attributes) {
        const attributes: Record<string, string> = { type: element.type };
        if (element.name) attributes.name = element.name;
        if (element.label) attributes.label = element.label;
        if (element.text) attributes.text = element.text;
        if (element.resourceId) attributes['resource-id'] = element.resourceId;
        if (element.contentDesc) attributes['content-desc'] = element.contentDesc;
        element.attributes = attributes;
    }
    return element;
}

describe('rankSelectorCandidates', () => {
    it('prioritizes unique high-confidence selectors', () => {
        const target = createElement({ name: 'loginBtn', xpath: '/Root[1]/Button[1]' });
        const sibling = createElement({
            elementRef: 'ios:/XCUIElementTypeButton[2]',
            index: 1,
            name: 'secondaryBtn',
            xpath: '/Root[1]/Button[2]',
        });

        const candidates: SelectorCandidate[] = [
            { strategy: 'class name', value: 'XCUIElementTypeButton', platform: 'generic' },
            { strategy: 'accessibility id', value: 'loginBtn', platform: 'ios' },
        ];

        const ranked = rankSelectorCandidates(target, [target, sibling], candidates);

        expect(ranked[0].strategy).toBe('accessibility id');
        expect(ranked[0].reasons).toContain('UNIQUE_MATCH');
        expect(ranked[1].reasons).toContain('MULTIPLE_MATCHES');
    });

    it('matches iOS id selectors against the normalized accessibility identifier', () => {
        const target = createElement({ name: 'loginBtn', resourceId: '' });
        const candidate: SelectorCandidate = { strategy: 'id', value: 'loginBtn', platform: 'ios' };

        expect(rankSelectorCandidates(target, [target], [candidate])[0].matchCount).toBe(1);
    });

    it('applies dynamic token penalty', () => {
        const target = createElement({ name: 'user_123456789' });
        const candidates: SelectorCandidate[] = [
            { strategy: 'accessibility id', value: 'user_123456789', platform: 'ios' },
        ];

        const ranked = rankSelectorCandidates(target, [target], candidates);

        expect(ranked[0].reasons).toContain('DYNAMIC_TOKEN_PENALTY');
    });

    it('marks no-match selectors', () => {
        const target = createElement({ xpath: '/Root[1]/Button[1]' });
        const candidates: SelectorCandidate[] = [
            { strategy: 'xpath', value: '/Root[1]/Button[99]', platform: 'generic' },
        ];

        const ranked = rankSelectorCandidates(target, [target], candidates);

        expect(ranked[0].matchCount).toBe(0);
        expect(ranked[0].reasons).toContain('NO_MATCH');
    });

    it('sorts by raw confidence before clamping public scores', () => {
        const target = createElement({ name: 'z' });
        const candidates: SelectorCandidate[] = [
            { strategy: '-ios predicate string', value: 'name == "z"', platform: 'ios' },
            { strategy: 'accessibility id', value: 'z', platform: 'ios' },
        ];

        const ranked = rankSelectorCandidates(target, [target], candidates);

        expect(ranked.map(candidate => candidate.strategy)).toEqual([
            'accessibility id',
            '-ios predicate string',
        ]);
        expect(ranked.map(candidate => candidate.score)).toEqual([100, 100]);
    });

    it('keeps every published score within the 0-100 boundary', () => {
        const target = createElement({ name: 'target' });
        const candidates: SelectorCandidate[] = [
            { strategy: 'id', value: 'missing', platform: 'android' },
            { strategy: 'accessibility id', value: 'target', platform: 'ios' },
            { strategy: 'xpath', value: '/a[1]/b[1]/c[1]/d[1]/e[1]/f[1]', platform: 'generic' },
        ];

        for (const candidate of rankSelectorCandidates(target, [target], candidates)) {
            expect(candidate.score).toBeGreaterThanOrEqual(0);
            expect(candidate.score).toBeLessThanOrEqual(100);
        }
    });

    it('locally matches generated selectors containing escaped characters', () => {
        const target = createElement({ name: 'say "hello" \\ now' });
        const candidates: SelectorCandidate[] = [
            {
                strategy: '-ios predicate string',
                value: 'name == "say \\"hello\\" \\\\ now"',
                platform: 'ios',
            },
            {
                strategy: '-ios class chain',
                value: '**/XCUIElementTypeButton[`name == "say \\"hello\\" \\\\ now"`]',
                platform: 'ios',
            },
        ];

        expect(rankSelectorCandidates(target, [target], candidates)
            .map(candidate => candidate.matchCount)).toEqual([1, 1]);
    });

    it('matches escaped control characters in generated platform selectors', () => {
        const value = 'line\nbreak\tcontrol\u0001';
        const targets = [
            createElement({ name: value, label: '' }),
            createElement({ platform: 'android', text: value, name: '', label: '' }),
        ];
        const candidates = targets.flatMap(generateSelectorCandidates).filter(candidate => (
            candidate.strategy === '-ios predicate string'
            || candidate.strategy === '-ios class chain'
            || candidate.strategy === '-android uiautomator'
        ));

        expect(rankSelectorCandidates(targets[0], targets, candidates)
            .map(candidate => candidate.matchCount)).toEqual([1, 1, 1]);
    });

    it('matches anchored single-quoted iOS predicate literals', () => {
        const target = createElement({ name: "it's ready", label: 'Ready now' });
        const candidates: SelectorCandidate[] = [
            { strategy: '-ios predicate string', value: "name == 'it\\'s ready'", platform: 'ios' },
            { strategy: '-ios predicate string', value: "label CONTAINS 'Ready'", platform: 'ios' },
        ];

        expect(rankSelectorCandidates(target, [target], candidates)
            .map(candidate => candidate.matchCount)).toEqual([1, 1]);
    });

    it.each([
        { strategy: '-ios predicate string', value: 'garbage name == "loginBtn" trailing', platform: 'ios' },
        { strategy: '-ios class chain', value: 'garbage**/XCUIElementTypeButton', platform: 'ios' },
        { strategy: '-android uiautomator', value: 'garbage.resourceId("id") trailing', platform: 'android' },
    ] as const)('does not match invalid $strategy syntax', candidate => {
        const target = createElement({ resourceId: 'id' });

        expect(rankSelectorCandidates(target, [target], [candidate])[0].matchCount).toBe(0);
    });

    it('matches standard Android class and hyphenated attributes in XPath', () => {
        const target = createElement({
            platform: 'android',
            type: 'android.widget.Button',
            resourceId: 'com.example:id/continue',
            contentDesc: 'continue',
            attributes: {
                class: 'android.widget.Button',
                'resource-id': 'com.example:id/continue',
                'content-desc': 'continue',
            },
        });
        const candidates: SelectorCandidate[] = [{
            strategy: 'xpath',
            value: '//*[@class="android.widget.Button" and @resource-id="com.example:id/continue"]',
            platform: 'generic',
        }];

        expect(rankSelectorCandidates(target, [target], candidates)[0].matchCount).toBe(1);
    });

    it('matches generated iOS selectors across deterministic escaped-string fuzz cases', () => {
        const alphabet = ['a', 'Z', '0', '-', '_', '"', '\\', '`', '\n', '\t', '\u0001'];
        let state = 0x12345678;
        const next = () => {
            state = (state * 1664525 + 1013904223) >>> 0;
            return state;
        };

        for (let caseIndex = 0; caseIndex < 200; caseIndex++) {
            const value = `name-${Array.from({ length: 20 }, () => alphabet[next() % alphabet.length]).join('')}`;
            const target = createElement({ name: value, label: '' });
            const candidates = generateSelectorCandidates(target).filter(candidate =>
                candidate.strategy === '-ios predicate string'
                || candidate.strategy === '-ios class chain'
            );

            expect(candidates).toHaveLength(2);
            expect(rankSelectorCandidates(target, [target], candidates)
                .map(candidate => candidate.matchCount)).toEqual([1, 1]);
        }
    });

    it('does not match Android UiAutomator text against content descriptions', () => {
        const text = createElement({
            platform: 'android',
            type: 'android.widget.Button',
            text: 'Continue',
            label: 'Continue',
            contentDesc: '',
        });
        const contentDescription = createElement({
            platform: 'android',
            type: 'android.widget.Button',
            index: 1,
            elementRef: 'android:/node[2]',
            text: '',
            label: 'Continue',
            contentDesc: 'Continue',
        });

        const ranked = rankSelectorCandidates(text, [text, contentDescription], [{
            strategy: '-android uiautomator',
            value: 'new UiSelector().text("Continue")',
            platform: 'android',
        }]);

        expect(ranked[0].matchCount).toBe(1);
    });
});
