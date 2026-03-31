import fastDiff from 'fast-diff';
import type { DiffSegment, DiffSummary } from '../types';

const DIFF_TYPE_MAP: Record<number, DiffSegment['type']> = {
    [fastDiff.EQUAL]: 'equal',
    [fastDiff.INSERT]: 'insert',
    [fastDiff.DELETE]: 'delete',
};

export function computeXmlDiff(prevXml: string, currXml: string): DiffSegment[] {
    const result = fastDiff(prevXml, currXml);
    return result.map(([type, text]) => ({
        type: DIFF_TYPE_MAP[type] ?? 'equal',
        text,
    }));
}

function countElements(xml: string): number {
    // Count opening tags (not self-closing comments or processing instructions)
    const matches = xml.match(/<[a-zA-Z][^>]*>/g);
    return matches ? matches.length : 0;
}

export function computeDiffSummary(prevXml: string | undefined, currXml: string | undefined): DiffSummary | null {
    if (!prevXml || !currXml) return null;

    const segments = computeXmlDiff(prevXml, currXml);
    const prevElementCount = countElements(prevXml);
    const currElementCount = countElements(currXml);

    return {
        segments,
        prevElementCount,
        currElementCount,
        elementCountDelta: currElementCount - prevElementCount,
    };
}
