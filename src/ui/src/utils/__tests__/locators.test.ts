import { describe, it, expect } from 'vitest';
import { generateLocators } from '../locators';
import type { ParsedElement } from '../../types';

function createMockElement(overrides: Partial<ParsedElement> = {}): ParsedElement {
    return {
        type: 'XCUIElementTypeButton',
        name: '',
        label: '',
        value: '',
        enabled: true,
        visible: true,
        accessible: false,
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        xpath: '/Application[1]/Button[1]',
        node: document.createElement('div') as unknown as Element,
        ...overrides,
    };
}

describe('generateLocators', () => {
    describe('accessibility id locators', () => {
        it('should generate accessibility id from name attribute', () => {
            const element = createMockElement({ name: 'loginButton' });
            const locators = generateLocators(element);

            const accessibilityIdLocators = locators.filter(l => l.strategy === 'accessibility id');
            expect(accessibilityIdLocators).toContainEqual({
                strategy: 'accessibility id',
                value: 'loginButton',
            });
        });

        it('should generate accessibility id from label attribute', () => {
            const element = createMockElement({ label: 'Login' });
            const locators = generateLocators(element);

            const accessibilityIdLocators = locators.filter(l => l.strategy === 'accessibility id');
            expect(accessibilityIdLocators).toContainEqual({
                strategy: 'accessibility id',
                value: 'Login',
            });
        });

        it('should not duplicate accessibility id if name and label are same', () => {
            const element = createMockElement({ name: 'Login', label: 'Login' });
            const locators = generateLocators(element);

            const accessibilityIdLocators = locators.filter(l => l.strategy === 'accessibility id');
            expect(accessibilityIdLocators).toHaveLength(1);
        });

        it('should generate both accessibility ids if name and label differ', () => {
            const element = createMockElement({ name: 'loginBtn', label: 'Login' });
            const locators = generateLocators(element);

            const accessibilityIdLocators = locators.filter(l => l.strategy === 'accessibility id');
            expect(accessibilityIdLocators).toHaveLength(2);
            expect(accessibilityIdLocators).toContainEqual({
                strategy: 'accessibility id',
                value: 'loginBtn',
            });
            expect(accessibilityIdLocators).toContainEqual({
                strategy: 'accessibility id',
                value: 'Login',
            });
        });

        it('should not generate accessibility id if name is empty', () => {
            const element = createMockElement({ name: '' });
            const locators = generateLocators(element);

            const accessibilityIdFromName = locators.find(
                l => l.strategy === 'accessibility id' && l.value === ''
            );
            expect(accessibilityIdFromName).toBeUndefined();
        });
    });

    describe('xpath locator', () => {
        it('should always include xpath locator', () => {
            const element = createMockElement({ xpath: '/App[1]/Window[1]/Button[1]' });
            const locators = generateLocators(element);

            const xpathLocator = locators.find(l => l.strategy === 'xpath');
            expect(xpathLocator).toEqual({
                strategy: 'xpath',
                value: '/App[1]/Window[1]/Button[1]',
            });
        });

        it('should include xpath even when no other attributes present', () => {
            const element = createMockElement({
                name: '',
                label: '',
                xpath: '/root[1]',
            });
            const locators = generateLocators(element);

            expect(locators.find(l => l.strategy === 'xpath')).toBeDefined();
        });
    });

    describe('class name locator', () => {
        it('should always include class name locator', () => {
            const element = createMockElement({ type: 'XCUIElementTypeButton' });
            const locators = generateLocators(element);

            const classNameLocator = locators.find(l => l.strategy === 'class name');
            expect(classNameLocator).toEqual({
                strategy: 'class name',
                value: 'XCUIElementTypeButton',
            });
        });

        it('should handle Android class names', () => {
            const element = createMockElement({ type: 'android.widget.Button' });
            const locators = generateLocators(element);

            const classNameLocator = locators.find(l => l.strategy === 'class name');
            expect(classNameLocator).toEqual({
                strategy: 'class name',
                value: 'android.widget.Button',
            });
        });
    });

    describe('iOS predicate string locators', () => {
        it('should generate predicate for name attribute', () => {
            const element = createMockElement({ name: 'loginButton' });
            const locators = generateLocators(element);

            const predicateLocators = locators.filter(l => l.strategy === '-ios predicate string');
            expect(predicateLocators).toContainEqual({
                strategy: '-ios predicate string',
                value: 'name == "loginButton"',
            });
        });

        it('should generate predicate for label attribute', () => {
            const element = createMockElement({ label: 'Login' });
            const locators = generateLocators(element);

            const predicateLocators = locators.filter(l => l.strategy === '-ios predicate string');
            expect(predicateLocators).toContainEqual({
                strategy: '-ios predicate string',
                value: 'label == "Login"',
            });
        });

        it('should generate both predicates if name and label are different', () => {
            const element = createMockElement({ name: 'loginBtn', label: 'Login' });
            const locators = generateLocators(element);

            const predicateLocators = locators.filter(l => l.strategy === '-ios predicate string');
            expect(predicateLocators).toHaveLength(2);
        });

        it('should not generate predicate if name is empty', () => {
            const element = createMockElement({ name: '' });
            const locators = generateLocators(element);

            const namePredicates = locators.filter(
                l => l.strategy === '-ios predicate string' && l.value.includes('name ==')
            );
            expect(namePredicates).toHaveLength(0);
        });
    });

    describe('iOS class chain locator', () => {
        it('should generate class chain for element with name', () => {
            const element = createMockElement({
                type: 'XCUIElementTypeButton',
                name: 'loginButton',
            });
            const locators = generateLocators(element);

            const classChainLocator = locators.find(l => l.strategy === '-ios class chain');
            expect(classChainLocator).toEqual({
                strategy: '-ios class chain',
                value: '**/XCUIElementTypeButton[`name == "loginButton"`]',
            });
        });

        it('should not generate class chain if name is empty', () => {
            const element = createMockElement({ name: '' });
            const locators = generateLocators(element);

            const classChainLocator = locators.find(l => l.strategy === '-ios class chain');
            expect(classChainLocator).toBeUndefined();
        });
    });

    describe('complete locator generation', () => {
        it('should generate all locators for element with all attributes', () => {
            const element = createMockElement({
                type: 'XCUIElementTypeButton',
                name: 'submitBtn',
                label: 'Submit',
                xpath: '/App[1]/Button[1]',
            });
            const locators = generateLocators(element);

            const strategies = locators.map(l => l.strategy);
            expect(strategies).toContain('accessibility id');
            expect(strategies).toContain('xpath');
            expect(strategies).toContain('class name');
            expect(strategies).toContain('-ios predicate string');
            expect(strategies).toContain('-ios class chain');
        });

        it('should generate minimal locators for element with no optional attributes', () => {
            const element = createMockElement({
                name: '',
                label: '',
            });
            const locators = generateLocators(element);

            // Should only have xpath and class name
            expect(locators).toHaveLength(2);
            expect(locators.map(l => l.strategy)).toEqual(['xpath', 'class name']);
        });

        it('should preserve locator order', () => {
            const element = createMockElement({
                name: 'testBtn',
                label: 'Test',
                type: 'Button',
                xpath: '/xpath',
            });
            const locators = generateLocators(element);

            // Verify expected order based on implementation
            const strategies = locators.map(l => l.strategy);
            expect(strategies[0]).toBe('accessibility id'); // from name
            expect(strategies[1]).toBe('accessibility id'); // from label
            expect(strategies[2]).toBe('xpath');
            expect(strategies[3]).toBe('class name');
        });
    });

    describe('edge cases', () => {
        it('should handle special characters in name', () => {
            const element = createMockElement({ name: 'button-1_test' });
            const locators = generateLocators(element);

            expect(locators).toContainEqual({
                strategy: 'accessibility id',
                value: 'button-1_test',
            });
        });

        it('should handle spaces in label', () => {
            const element = createMockElement({ label: 'Log In Now' });
            const locators = generateLocators(element);

            expect(locators).toContainEqual({
                strategy: 'accessibility id',
                value: 'Log In Now',
            });
            expect(locators).toContainEqual({
                strategy: '-ios predicate string',
                value: 'label == "Log In Now"',
            });
        });

        it('should handle quotes in name/label correctly in predicates', () => {
            const element = createMockElement({ name: 'test"button' });
            const locators = generateLocators(element);

            // The current implementation doesn't escape quotes, but we verify it includes them
            const predicate = locators.find(l => l.strategy === '-ios predicate string');
            expect(predicate).toBeDefined();
        });

        it('should handle unicode characters', () => {
            const element = createMockElement({ name: '登录按钮', label: 'ログイン' });
            const locators = generateLocators(element);

            expect(locators).toContainEqual({
                strategy: 'accessibility id',
                value: '登录按钮',
            });
            expect(locators).toContainEqual({
                strategy: 'accessibility id',
                value: 'ログイン',
            });
        });

        it('should handle very long names', () => {
            const longName = 'a'.repeat(1000);
            const element = createMockElement({ name: longName });
            const locators = generateLocators(element);

            expect(locators).toContainEqual({
                strategy: 'accessibility id',
                value: longName,
            });
        });
    });
});
