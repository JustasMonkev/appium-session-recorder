import { describe, it, expect } from 'vitest';
import { computeXmlDiff, computeDiffSummary } from '../../src/ui/src/utils/diff';

describe('computeXmlDiff', () => {
    it('should return equal segment for identical XML', () => {
        const xml = '<root><child/></root>';
        const result = computeXmlDiff(xml, xml);

        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('equal');
        expect(result[0].text).toBe(xml);
    });

    it('should detect insertions', () => {
        const prev = '<root></root>';
        const curr = '<root><child/></root>';
        const result = computeXmlDiff(prev, curr);

        const insertSegments = result.filter(s => s.type === 'insert');
        expect(insertSegments.length).toBeGreaterThan(0);
        // fast-diff works at character level, so inserted text may not align with XML tags
        const insertedText = insertSegments.map(s => s.text).join('');
        expect(insertedText).toContain('child/');
    });

    it('should detect deletions', () => {
        const prev = '<root><child/></root>';
        const curr = '<root></root>';
        const result = computeXmlDiff(prev, curr);

        const deleteSegments = result.filter(s => s.type === 'delete');
        expect(deleteSegments.length).toBeGreaterThan(0);
        const deletedText = deleteSegments.map(s => s.text).join('');
        expect(deletedText).toContain('child/');
    });

    it('should detect mixed changes', () => {
        const prev = '<root><a name="old"/></root>';
        const curr = '<root><a name="new"/></root>';
        const result = computeXmlDiff(prev, curr);

        const types = new Set(result.map(s => s.type));
        expect(types.has('equal')).toBe(true);
        // Should have either insert+delete or just changes
        expect(types.size).toBeGreaterThan(1);
    });
});

describe('computeDiffSummary', () => {
    it('should return null when prevXml is undefined', () => {
        expect(computeDiffSummary(undefined, '<root/>')).toBeNull();
    });

    it('should return null when currXml is undefined', () => {
        expect(computeDiffSummary('<root/>', undefined)).toBeNull();
    });

    it('should count elements correctly', () => {
        const prev = '<root><a/><b/></root>';
        const curr = '<root><a/><b/><c/></root>';
        const result = computeDiffSummary(prev, curr);

        expect(result).not.toBeNull();
        expect(result!.prevElementCount).toBe(3); // root, a, b
        expect(result!.currElementCount).toBe(4); // root, a, b, c
        expect(result!.elementCountDelta).toBe(1);
    });

    it('should report negative delta when elements are removed', () => {
        const prev = '<root><a/><b/><c/></root>';
        const curr = '<root><a/></root>';
        const result = computeDiffSummary(prev, curr);

        expect(result).not.toBeNull();
        expect(result!.elementCountDelta).toBe(-2);
    });

    it('should report zero delta when element count is unchanged', () => {
        const prev = '<root><a name="old"/></root>';
        const curr = '<root><a name="new"/></root>';
        const result = computeDiffSummary(prev, curr);

        expect(result).not.toBeNull();
        expect(result!.elementCountDelta).toBe(0);
    });

    it('should include diff segments', () => {
        const prev = '<root><a/></root>';
        const curr = '<root><b/></root>';
        const result = computeDiffSummary(prev, curr);

        expect(result).not.toBeNull();
        expect(result!.segments.length).toBeGreaterThan(0);
    });
});
