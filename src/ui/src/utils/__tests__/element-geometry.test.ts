import { describe, it, expect } from 'vitest';
import { computeScale, elementToOverlayRect, renderedToSource, pointInElement, hitTest } from '../element-geometry';
import type { ParsedElement } from '../../types';

function makeElement(overrides: Partial<ParsedElement> = {}): ParsedElement {
    return {
        type: 'Button',
        name: '',
        label: '',
        value: '',
        enabled: true,
        visible: true,
        accessible: true,
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        xpath: '/App[1]/Button[1]',
        node: null as unknown as Element,
        ...overrides,
    };
}

describe('computeScale', () => {
    it('should compute correct scale factors', () => {
        const scale = computeScale(350, 700, 1080, 2160);
        expect(scale.scaleX).toBeCloseTo(350 / 1080);
        expect(scale.scaleY).toBeCloseTo(700 / 2160);
    });

    it('should return 1:1 when natural dimensions are zero', () => {
        const scale = computeScale(350, 700, 0, 0);
        expect(scale.scaleX).toBe(1);
        expect(scale.scaleY).toBe(1);
    });

    it('should handle equal rendered and natural dimensions', () => {
        const scale = computeScale(1080, 2160, 1080, 2160);
        expect(scale.scaleX).toBe(1);
        expect(scale.scaleY).toBe(1);
    });
});

describe('elementToOverlayRect', () => {
    it('should scale element bounds to overlay coordinates', () => {
        const el = makeElement({ x: 100, y: 200, width: 300, height: 50 });
        const scale = { scaleX: 0.5, scaleY: 0.25 };
        const rect = elementToOverlayRect(el, scale);

        expect(rect.left).toBe(50);
        expect(rect.top).toBe(50);
        expect(rect.width).toBe(150);
        expect(rect.height).toBe(12.5);
    });

    it('should handle 1:1 scale', () => {
        const el = makeElement({ x: 10, y: 20, width: 30, height: 40 });
        const scale = { scaleX: 1, scaleY: 1 };
        const rect = elementToOverlayRect(el, scale);

        expect(rect.left).toBe(10);
        expect(rect.top).toBe(20);
        expect(rect.width).toBe(30);
        expect(rect.height).toBe(40);
    });
});

describe('renderedToSource', () => {
    it('should convert rendered coordinates back to source', () => {
        const scale = { scaleX: 0.5, scaleY: 0.25 };
        const source = renderedToSource(50, 50, scale);
        expect(source.x).toBe(100);
        expect(source.y).toBe(200);
    });

    it('should handle zero scale gracefully', () => {
        const scale = { scaleX: 0, scaleY: 0 };
        const source = renderedToSource(100, 200, scale);
        expect(source.x).toBe(0);
        expect(source.y).toBe(0);
    });
});

describe('pointInElement', () => {
    it('should return true when point is inside element', () => {
        const el = makeElement({ x: 10, y: 10, width: 100, height: 50 });
        expect(pointInElement(50, 30, el)).toBe(true);
    });

    it('should return true on element boundary', () => {
        const el = makeElement({ x: 10, y: 10, width: 100, height: 50 });
        expect(pointInElement(10, 10, el)).toBe(true);
        expect(pointInElement(110, 60, el)).toBe(true);
    });

    it('should return false when point is outside element', () => {
        const el = makeElement({ x: 10, y: 10, width: 100, height: 50 });
        expect(pointInElement(5, 30, el)).toBe(false);
        expect(pointInElement(50, 5, el)).toBe(false);
        expect(pointInElement(111, 30, el)).toBe(false);
        expect(pointInElement(50, 61, el)).toBe(false);
    });
});

describe('hitTest', () => {
    it('should return null for empty elements', () => {
        expect(hitTest(50, 50, [])).toBeNull();
    });

    it('should return null when no element contains the point', () => {
        const elements = [makeElement({ x: 200, y: 200, width: 50, height: 50 })];
        expect(hitTest(10, 10, elements)).toBeNull();
    });

    it('should return the element that contains the point', () => {
        const el = makeElement({ x: 0, y: 0, width: 200, height: 200 });
        expect(hitTest(100, 100, [el])).toBe(el);
    });

    it('should prefer smallest area when elements overlap', () => {
        const container = makeElement({
            x: 0, y: 0, width: 500, height: 500,
            xpath: '/App[1]',
        });
        const button = makeElement({
            x: 50, y: 50, width: 100, height: 50,
            xpath: '/App[1]/Button[1]',
        });
        expect(hitTest(75, 75, [container, button])).toBe(button);
    });

    it('should prefer deepest xpath when areas are equal', () => {
        const a = makeElement({
            x: 10, y: 10, width: 100, height: 100,
            xpath: '/App[1]/View[1]',
        });
        const b = makeElement({
            x: 10, y: 10, width: 100, height: 100,
            xpath: '/App[1]/View[1]/Inner[1]',
        });
        expect(hitTest(50, 50, [a, b])).toBe(b);
    });

    it('should ignore invisible elements', () => {
        const invisible = makeElement({
            x: 0, y: 0, width: 500, height: 500,
            visible: false,
            xpath: '/App[1]/Hidden[1]',
        });
        const visible = makeElement({
            x: 0, y: 0, width: 200, height: 200,
            visible: true,
            xpath: '/App[1]/Visible[1]',
        });
        expect(hitTest(100, 100, [invisible, visible])).toBe(visible);
    });

    it('should ignore zero-area elements', () => {
        const zeroArea = makeElement({
            x: 50, y: 50, width: 0, height: 0,
            xpath: '/App[1]/Zero[1]',
        });
        const normal = makeElement({
            x: 0, y: 0, width: 200, height: 200,
            xpath: '/App[1]/Normal[1]',
        });
        expect(hitTest(50, 50, [zeroArea, normal])).toBe(normal);
    });

    it('should prefer later traversal index as final tiebreaker', () => {
        const a = makeElement({
            x: 10, y: 10, width: 100, height: 100,
            xpath: '/App[1]/A[1]',
        });
        const b = makeElement({
            x: 10, y: 10, width: 100, height: 100,
            xpath: '/App[1]/B[1]',
        });
        // Same area, same depth — b comes later in array
        expect(hitTest(50, 50, [a, b])).toBe(b);
    });
});
