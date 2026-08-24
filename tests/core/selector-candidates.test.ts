import { describe, it, expect } from 'vitest';
import { generateSelectorCandidates } from '../../src/core/selectors/generate-candidates';
import { compileCandidateMatcher, rankSelectorCandidates } from '../../src/core/selectors/score-candidates';
import { parseSource } from '../../src/core/xml/parse-source';
import type { ParsedElement } from '../../src/core/types';

function createElement(overrides: Partial<ParsedElement>): ParsedElement {
    const element: ParsedElement = {
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

    it('does not mistake visible Android text for an accessibility id', () => {
        const element = createElement({
            platform: 'android',
            type: 'android.widget.Button',
            name: 'Continue',
            label: 'Continue',
            text: 'Continue',
            contentDesc: '',
            attributes: { class: 'android.widget.Button', text: 'Continue' },
        });

        const candidates = generateSelectorCandidates(element);

        expect(candidates.some(candidate => candidate.strategy === 'accessibility id')).toBe(false);
        expect(candidates).toContainEqual({
            strategy: 'xpath',
            value: '//*[@class="android.widget.Button" and @text="Continue"]',
            platform: 'generic',
        });
    });

    it('generates valid web id, class, and XPath selectors', () => {
        const elements = parseSource(
            '<html><body><button id="save" class="primary">Save</button><button id="cancel">Cancel</button></body></html>',
        ).elements;
        const button = elements.find(element => element.resourceId === 'save')!;
        const candidates = generateSelectorCandidates(button);

        expect(candidates).toContainEqual({ strategy: 'id', value: 'save', platform: 'unknown' });
        expect(candidates).toContainEqual({ strategy: 'class name', value: 'primary', platform: 'generic' });
        expect(candidates).toContainEqual({
            strategy: 'xpath', value: '//button[@id="save"]', platform: 'generic',
        });
        expect(candidates.some(candidate => candidate.strategy === 'accessibility id')).toBe(false);
        expect(compileCandidateMatcher({
            strategy: 'accessibility id', value: 'save', platform: 'generic',
        })(button)).toBe(false);
        expect(rankSelectorCandidates(button, elements, candidates)[0]).toMatchObject({
            strategy: 'id', value: 'save', matchCount: 1,
        });
    });

    it('matches HTML class names only against ASCII-whitespace class tokens', () => {
        const elements = parseSource(
            '<html><body><div id=target class="button"></div><button></button><div id=nbsp class="foo&nbsp;bar"></div></body></html>',
        ).elements;
        const target = elements.find(element => element.resourceId === 'target')!;
        const bareButton = elements.find(element => element.type === 'button')!;
        const nbsp = elements.find(element => element.resourceId === 'nbsp')!;
        const classCandidate = generateSelectorCandidates(target).find(candidate => candidate.strategy === 'class name')!;
        const nbspCandidate = generateSelectorCandidates(nbsp).find(candidate => candidate.strategy === 'class name')!;

        expect(classCandidate.value).toBe('button');
        expect(compileCandidateMatcher(classCandidate)(bareButton)).toBe(false);
        expect(rankSelectorCandidates(target, elements, [classCandidate])[0].matchCount).toBe(1);
        expect(nbspCandidate.value).toBe('foo\u00a0bar');
        expect(compileCandidateMatcher(nbspCandidate)(nbsp)).toBe(true);
    });

    it('does not treat native aliases as web IDs or remove generic XML accessibility names', () => {
        const htmlButton = parseSource(
            '<html><body><button resource-id="fake" content-desc="also-fake">Go</button></body></html>',
        ).elements.at(-1)!;
        const genericButton = parseSource('<Root><Button name="save"/></Root>').elements[1];

        expect(htmlButton.resourceId).toBe('');
        expect(generateSelectorCandidates(htmlButton).some(candidate => candidate.strategy === 'id')).toBe(false);
        expect(generateSelectorCandidates(genericButton)).toContainEqual({
            strategy: 'accessibility id', value: 'save', platform: 'unknown',
        });
        expect(compileCandidateMatcher({
            strategy: 'accessibility id', value: 'save', platform: 'generic',
        })(genericButton)).toBe(true);
    });

    it('uses the real XML class attribute or tag in generated generic XPath', () => {
        const elements = parseSource('<Root><node class="Button" name="go"/><Button name="tagged"/></Root>').elements;

        const classXPath = generateSelectorCandidates(elements[1]).find(candidate => (
            candidate.strategy === 'xpath' && candidate.value.startsWith('//')
        ));
        const tagXPath = generateSelectorCandidates(elements[2]).find(candidate => (
            candidate.strategy === 'xpath' && candidate.value.startsWith('//')
        ));

        expect(classXPath?.value).toBe('//*[@class="Button" and @name="go"]');
        expect(tagXPath?.value).toBe('//Button[@name="tagged"]');
    });

    it('escapes quotes and backslashes in generated platform selectors', () => {
        const value = 'say "hello" \\ now';
        const iosCandidates = generateSelectorCandidates(createElement({ name: value }));
        const androidCandidates = generateSelectorCandidates(createElement({
            platform: 'android',
            type: 'android.widget.TextView',
            text: value,
        }));

        expect(iosCandidates).toContainEqual({
            strategy: '-ios predicate string',
            value: 'name == "say \\"hello\\" \\\\ now"',
            platform: 'ios',
        });
        expect(androidCandidates).toContainEqual({
            strategy: '-android uiautomator',
            value: 'new UiSelector().text("say \\"hello\\" \\\\ now")',
            platform: 'android',
        });
    });

    it('escapes control characters in platform string literals', () => {
        const value = 'line\nbreak\tcontrol\u0001';
        const iosCandidates = generateSelectorCandidates(createElement({ name: value }));
        const androidCandidates = generateSelectorCandidates(createElement({
            platform: 'android',
            type: 'android.widget.TextView',
            text: value,
        }));

        expect(iosCandidates).toContainEqual({
            strategy: '-ios predicate string',
            value: 'name == "line\\nbreak\\tcontrol\\u0001"',
            platform: 'ios',
        });
        expect(androidCandidates).toContainEqual({
            strategy: '-android uiautomator',
            value: 'new UiSelector().text("line\\nbreak\\tcontrol\\u0001")',
            platform: 'android',
        });
    });

    it('omits an unsafe conditional XPath when a value contains both quote styles', () => {
        const element = createElement({ name: 'He said "don\'t"' });

        const xpaths = generateSelectorCandidates(element)
            .filter(candidate => candidate.strategy === 'xpath');

        expect(xpaths).toEqual([{
            strategy: 'xpath',
            value: element.xpath,
            platform: 'generic',
        }]);
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
