import { describe, it, expect } from 'vitest';
import { rankSelectorCandidates } from '../../src/core/selectors/score-candidates';
import type { ParsedElement, SelectorCandidate } from '../../src/core/types';

function createElement(overrides: Partial<ParsedElement>): ParsedElement {
    return {
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
});
