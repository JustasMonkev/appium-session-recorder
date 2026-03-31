import type { ParsedElement } from '../types';

export type ScaleFactor = {
    scaleX: number;
    scaleY: number;
};

export type OverlayRect = {
    left: number;
    top: number;
    width: number;
    height: number;
};

/**
 * Compute the scale factor between the rendered image size and the natural (source) image size.
 */
export function computeScale(
    renderedWidth: number,
    renderedHeight: number,
    naturalWidth: number,
    naturalHeight: number,
): ScaleFactor {
    if (naturalWidth === 0 || naturalHeight === 0) {
        return { scaleX: 1, scaleY: 1 };
    }
    return {
        scaleX: renderedWidth / naturalWidth,
        scaleY: renderedHeight / naturalHeight,
    };
}

/**
 * Map an element's bounds from source coordinates to rendered overlay coordinates.
 */
export function elementToOverlayRect(element: ParsedElement, scale: ScaleFactor): OverlayRect {
    return {
        left: element.x * scale.scaleX,
        top: element.y * scale.scaleY,
        width: element.width * scale.scaleX,
        height: element.height * scale.scaleY,
    };
}

/**
 * Convert a click position on the rendered image back to source coordinates.
 */
export function renderedToSource(
    renderedX: number,
    renderedY: number,
    scale: ScaleFactor,
): { x: number; y: number } {
    return {
        x: scale.scaleX === 0 ? 0 : renderedX / scale.scaleX,
        y: scale.scaleY === 0 ? 0 : renderedY / scale.scaleY,
    };
}

/**
 * Check whether a point (in source coordinates) falls within an element's bounds.
 */
export function pointInElement(px: number, py: number, el: ParsedElement): boolean {
    return (
        px >= el.x &&
        px <= el.x + el.width &&
        py >= el.y &&
        py <= el.y + el.height
    );
}

/**
 * Find the best element at a given source-coordinate point.
 *
 * Selection criteria (in priority order):
 * 1. Ignore invisible or zero-area elements.
 * 2. The element bounds must contain the point.
 * 3. Prefer smallest area (leaf nodes over containers).
 * 4. Deepest xpath (most path segments) as tiebreaker.
 * 5. Latest traversal index as final fallback.
 */
export function hitTest(
    px: number,
    py: number,
    elements: ParsedElement[],
): ParsedElement | null {
    const candidates = elements.filter((el) => {
        if (el.width === 0 || el.height === 0) return false;
        if (!el.visible) return false;
        return pointInElement(px, py, el);
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
        const areaA = a.width * a.height;
        const areaB = b.width * b.height;
        if (areaA !== areaB) return areaA - areaB;

        const depthA = a.xpath.split('/').length;
        const depthB = b.xpath.split('/').length;
        if (depthA !== depthB) return depthB - depthA;

        // Later in traversal order = higher index in array
        return elements.indexOf(b) - elements.indexOf(a);
    });

    return candidates[0];
}
