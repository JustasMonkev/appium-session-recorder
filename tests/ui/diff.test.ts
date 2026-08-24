import { describe, it, expect } from 'vitest';
import { computeDiffSummary } from '../../src/ui/src/utils/diff';
import { formatXml } from '../../src/ui/src/utils/format-xml';

function reconstruct(rows: NonNullable<ReturnType<typeof computeDiffSummary>>['rows'], side: 'previous' | 'current') {
    const lines = rows.flatMap(row => {
        const text = side === 'previous' ? row.previousText : row.currentText;
        return text === null ? [] : [text];
    });
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

describe('diff rows', () => {
    it('returns unchanged rows for identical XML', () => {
        const xml = '<root><child/></root>';
        const result = computeDiffSummary(xml, xml);

        expect(result?.changedLineCount).toBe(0);
        expect(result?.rows.map(row => row.currentText)).toEqual(['<root>', '  <child/>', '</root>']);
    });

    it('detects insertions', () => {
        const prev = '<root></root>';
        const curr = '<root><child/></root>';
        const result = computeDiffSummary(prev, curr);

        expect(result?.insertedLineCount).toBeGreaterThan(0);
        expect(result?.rows.some(row => row.currentText?.includes('child/'))).toBe(true);
    });

    it('detects deletions', () => {
        const prev = '<root><child/></root>';
        const curr = '<root></root>';
        const result = computeDiffSummary(prev, curr);

        expect(result?.deletedLineCount).toBeGreaterThan(0);
        expect(result?.rows.some(row => row.previousText?.includes('child/'))).toBe(true);
    });

    it('detects mixed changes', () => {
        const prev = '<root><a name="old"/></root>';
        const curr = '<root><a name="new"/></root>';
        const result = computeDiffSummary(prev, curr);

        expect(result?.insertedLineCount).toBeGreaterThan(0);
        expect(result?.deletedLineCount).toBeGreaterThan(0);
    });

    it('reconstructs both inputs across deterministic fuzz cases', () => {
        let state = 0x9e3779b9;
        const nextXml = () => `<root>${Array.from({ length: 20 }, () => {
            state = (state * 1103515245 + 12345) >>> 0;
            return `<item id="${state % 17}"/>`;
        }).join('')}</root>`;

        for (let caseIndex = 0; caseIndex < 250; caseIndex++) {
            const previous = nextXml();
            const current = nextXml();
            const summary = computeDiffSummary(previous, current);
            expect(summary).not.toBeNull();

            expect(reconstruct(summary!.rows, 'previous')).toBe(formatXml(previous));
            expect(reconstruct(summary!.rows, 'current')).toBe(formatXml(current));
        }
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

    it('ignores markup-looking content in comments and CDATA when counting elements', () => {
        const xml = '<?xml version="1.0"?><root><!-- <fake/> --><![CDATA[<fake/>]]><real/></root>';
        const result = computeDiffSummary(xml, xml);

        expect(result?.prevElementCount).toBe(2);
        expect(result?.currElementCount).toBe(2);
        expect(formatXml(xml)).toBe([
            '<?xml version="1.0"?>',
            '<root>',
            '  <!-- <fake/> -->',
            '  <![CDATA[<fake/>]]>',
            '  <real/>',
            '</root>',
            '',
        ].join('\n'));
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

    it('should include diff rows', () => {
        const prev = '<root><a/></root>';
        const curr = '<root><b/></root>';
        const result = computeDiffSummary(prev, curr);

        expect(result).not.toBeNull();
        expect(result!.rows.length).toBeGreaterThan(0);
    });

    it.each([
        '<a></b>',
        '<a/><b/>',
        '<a>'.repeat(3_000),
    ])('rejects malformed XML without formatting amplification', xml => {
        expect(formatXml(xml)).toBe('');
        expect(computeDiffSummary('<root/>', xml)).toBeNull();
    });

    it('accepts the depth boundary and rejects one level beyond it', () => {
        const nested = (depth: number) => `${'<Node>'.repeat(depth)}${'</Node>'.repeat(depth)}`;

        expect(formatXml(nested(96))).not.toBe('');
        expect(formatXml(nested(97))).toBe('');
    });

    it('declines an adversarial diff that exceeds the formatted character budget', () => {
        const oversized = `<root>${'x'.repeat(2 * 1024 * 1024)}</root>`;

        expect(computeDiffSummary('<root/>', oversized)).toBeNull();
    });

    it('declines an adversarial diff that exceeds the formatted line budget', () => {
        const oversized = `<root>${'x\n'.repeat(2_001)}</root>`;

        expect(computeDiffSummary('<root/>', oversized)).toBeNull();
    });

    it('accepts exactly 2,000 formatted lines across both inputs and rejects 2,001', () => {
        const xml = (children: number) => `<root>${'<item/>'.repeat(children)}</root>`;

        expect(computeDiffSummary(xml(998), xml(998))).not.toBeNull();
        expect(computeDiffSummary(xml(998), xml(999))).toBeNull();
    });

    it('preserves mixed-content XML instead of inserting semantic whitespace', () => {
        const xml = '<root>Hello<child/>world</root>';

        expect(formatXml(xml)).toBe(`${xml}\n`);
        expect(reconstruct(computeDiffSummary(xml, xml)!.rows, 'current')).toBe(`${xml}\n`);
    });

    it('preserves multiline CDATA whitespace and detects changes within it', () => {
        const previous = '<root><![CDATA[\n  significant text  \n]]></root>';
        const current = '<root><![CDATA[\n significant text  \n]]></root>';

        expect(formatXml(previous)).toBe(`${previous}\n`);
        expect(formatXml(current)).toBe(`${current}\n`);
        expect(computeDiffSummary(previous, current)?.changedLineCount).toBe(2);
    });
});
