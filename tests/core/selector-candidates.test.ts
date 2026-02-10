import { describe, it, expect } from 'vitest';
import { generateSelectorCandidates } from '../../src/core/selectors/generate-candidates';
import type { ParsedElement } from '../../src/core/types';

function createElement(overrides: Partial<ParsedElement>): ParsedElement {
    return {
        elementRef: 'ios:/XCUIElementTypeButton[1]',
        index: 0,
        platform: 'ios',
        type: 'XCUIElementTypeButton',
        xpath: '/XCUIElementTypeApplication[1]/XCUIElementTypeButton[1]',
        name: '',
        label: '',
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

describe('generateSelectorCandidates', () => {
    it('generates iOS locator families', () => {
        const element = createElement({
            platform: 'ios',
            name: 'loginBtn',
            label: 'Log In',
            type: 'XCUIElementTypeButton',
        });

        const candidates = generateSelectorCandidates(element);
        const strategies = candidates.map(candidate => candidate.strategy);

        expect(strategies).toContain('accessibility id');
        expect(strategies).toContain('-ios predicate string');
        expect(strategies).toContain('-ios class chain');
        expect(strategies).toContain('xpath');
        expect(strategies).toContain('class name');
    });

    it('generates Android-specific candidates', () => {
        const element = createElement({
            platform: 'android',
            type: 'android.widget.Button',
            text: 'Continue',
            resourceId: 'com.example:id/continue',
            contentDesc: 'continueButton',
        });

        const candidates = generateSelectorCandidates(element);

        expect(candidates).toContainEqual({
            strategy: 'id',
            value: 'com.example:id/continue',
            platform: 'android',
        });

        expect(candidates.some(candidate => candidate.strategy === '-android uiautomator')).toBe(true);
        expect(candidates.some(candidate => candidate.strategy === 'accessibility id' && candidate.value === 'continueButton')).toBe(true);
    });

    it('always includes xpath and class name fallback', () => {
        const element = createElement({
            platform: 'unknown',
            type: 'GenericButton',
            xpath: '/Root[1]/GenericButton[1]',
        });

        const candidates = generateSelectorCandidates(element);

        expect(candidates).toContainEqual({ strategy: 'xpath', value: '/Root[1]/GenericButton[1]', platform: 'generic' });
        expect(candidates).toContainEqual({ strategy: 'class name', value: 'GenericButton', platform: 'generic' });
    });
});
