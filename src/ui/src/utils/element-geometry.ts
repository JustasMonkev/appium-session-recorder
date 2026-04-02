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
 * 1. Ignore explicitly hidden or zero-area elements.
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
    let bestCandidate: {
        element: ParsedElement;
        area: number;
        depth: number;
        index: number;
    } | null = null;

    for (let index = 0; index < elements.length; index++) {
        const element = elements[index];
        if (element.width === 0 || element.height === 0) continue;
        if (!element.visible) continue;
        if (!pointInElement(px, py, element)) continue;

        const candidate = {
            element,
            area: element.width * element.height,
            depth: element.xpath.split('/').length,
            index,
        };

        if (
            bestCandidate === null ||
            candidate.area < bestCandidate.area ||
            (candidate.area === bestCandidate.area && candidate.depth > bestCandidate.depth) ||
            (
                candidate.area === bestCandidate.area &&
                candidate.depth === bestCandidate.depth &&
                candidate.index > bestCandidate.index
            )
        ) {
            bestCandidate = candidate;
        }
    }

    return bestCandidate?.element ?? null;
}
