import { describe, it, expect } from 'vitest';
import { evaluateSelectorStability } from '../../src/core/selectors/selector-stability';
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

describe('evaluateSelectorStability', () => {
    it('should report full stability when selector is unique across all snapshots', () => {
        const el = createElement({ name: 'loginBtn' });
        const otherEl = createElement({ name: 'otherBtn', index: 1, elementRef: 'ios:/Button[2]' });

        const snapshots = [
            [el, otherEl],
            [el, otherEl],
            [el, otherEl],
        ];

        const candidates: SelectorCandidate[] = [
            { strategy: 'accessibility id', value: 'loginBtn', platform: 'ios' },
        ];

        const report = evaluateSelectorStability(candidates, snapshots);

        expect(report.results).toHaveLength(1);
        expect(report.results[0].stableSteps).toBe(3);
        expect(report.results[0].firstFailureStep).toBe(0);
        expect(report.results[0].totalSteps).toBe(3);
        expect(report.bestCandidate).toEqual(candidates[0]);
    });

    it('should detect selector failure when element disappears', () => {
        const el = createElement({ name: 'loginBtn' });
        const otherEl = createElement({ name: 'otherBtn', index: 1, elementRef: 'ios:/Button[2]' });

        const snapshots = [
            [el, otherEl],
            [otherEl], // el disappeared
            [otherEl],
        ];

        const candidates: SelectorCandidate[] = [
            { strategy: 'accessibility id', value: 'loginBtn', platform: 'ios' },
        ];

        const report = evaluateSelectorStability(candidates, snapshots);

        expect(report.results[0].stableSteps).toBe(1);
        expect(report.results[0].firstFailureStep).toBe(2);
    });

    it('should detect failure when selector matches multiple elements', () => {
        const el1 = createElement({ name: 'btn', index: 0, elementRef: 'ios:/Button[1]' });
        const el2 = createElement({ name: 'btn', index: 1, elementRef: 'ios:/Button[2]' });
        const elUnique = createElement({ name: 'btn', index: 0, elementRef: 'ios:/Button[1]' });

        const snapshots = [
            [elUnique],      // 1 match - stable
            [el1, el2],      // 2 matches - fail
        ];

        const candidates: SelectorCandidate[] = [
            { strategy: 'accessibility id', value: 'btn', platform: 'ios' },
        ];

        const report = evaluateSelectorStability(candidates, snapshots);

        expect(report.results[0].stableSteps).toBe(1);
        expect(report.results[0].firstFailureStep).toBe(2);
    });

    it('should rank most stable selector first', () => {
        const el = createElement({ name: 'loginBtn', type: 'XCUIElementTypeButton' });
        const otherBtn = createElement({ name: 'otherBtn', type: 'XCUIElementTypeButton', index: 1, elementRef: 'ios:/Button[2]' });

        const snapshots = [
            [el, otherBtn],
            [el, otherBtn],
            [el, otherBtn],
        ];

        const candidates: SelectorCandidate[] = [
            { strategy: 'class name', value: 'XCUIElementTypeButton', platform: 'generic' }, // matches 2 = fails
            { strategy: 'accessibility id', value: 'loginBtn', platform: 'ios' }, // matches 1 = stable
        ];

        const report = evaluateSelectorStability(candidates, snapshots);

        expect(report.results[0].candidate.strategy).toBe('accessibility id');
        expect(report.results[0].stableSteps).toBe(3);
        expect(report.results[1].candidate.strategy).toBe('class name');
        expect(report.results[1].stableSteps).toBe(0);
        expect(report.bestCandidate!.strategy).toBe('accessibility id');
    });

    it('should return null bestCandidate when no selectors are stable', () => {
        const snapshots: ParsedElement[][] = [[]]; // empty snapshot

        const candidates: SelectorCandidate[] = [
            { strategy: 'accessibility id', value: 'nonexistent', platform: 'ios' },
        ];

        const report = evaluateSelectorStability(candidates, snapshots);

        expect(report.bestCandidate).toBeNull();
    });

    it('should handle empty candidates', () => {
        const el = createElement({});
        const report = evaluateSelectorStability([], [[el]]);

        expect(report.results).toHaveLength(0);
        expect(report.bestCandidate).toBeNull();
    });

    it('should handle empty snapshots', () => {
        const candidates: SelectorCandidate[] = [
            { strategy: 'accessibility id', value: 'btn', platform: 'ios' },
        ];

        const report = evaluateSelectorStability(candidates, []);

        expect(report.results[0].stableSteps).toBe(0);
        expect(report.results[0].totalSteps).toBe(0);
    });
});
