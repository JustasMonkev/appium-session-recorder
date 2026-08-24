import fastDiff from 'fast-diff';
import { analyzeXml, type XmlAnalysis } from '../../../core/xml/xml-limits';
import type { DiffLine, DiffRow, DiffSummary } from '../types';
import { formatXml } from './format-xml';

const DIFF_TYPE_MAP: Record<number, DiffLine['type']> = {
    [fastDiff.EQUAL]: 'equal',
    [fastDiff.INSERT]: 'insert',
    [fastDiff.DELETE]: 'delete',
};
const MAX_DIFF_LINES = 2_000;
const MAX_FORMATTED_DIFF_CHARS = 2 * 1024 * 1024;

function formatXmlLines(xml: string, analysis: XmlAnalysis): string[] | undefined {
    const formatted = formatXml(xml, analysis);
    if (!formatted || formatted.length > MAX_FORMATTED_DIFF_CHARS) return undefined;
    const lines = formatted.trimEnd().split('\n');
    return lines.length <= MAX_DIFF_LINES ? lines : undefined;
}

function buildEncodedLineDiff(prevLines: string[], currLines: string[]) {
    const lineToToken = new Map<string, string>();
    const tokenToLine = new Map<string, string>();
    let nextCodePoint = 0x10000;

    const encode = (lines: string[]) => lines.map((line) => {
        let token = lineToToken.get(line);
        if (!token) {
            token = String.fromCodePoint(nextCodePoint++);
            lineToToken.set(line, token);
            tokenToLine.set(token, line);
        }

        return token;
    }).join('');

    return {
        diff: fastDiff(encode(prevLines), encode(currLines)),
        tokenToLine,
    };
}

function buildDiffLines(
    prevXml: string,
    currXml: string,
    prevAnalysis: XmlAnalysis,
    currAnalysis: XmlAnalysis,
): DiffLine[] | undefined {
    const prevLines = formatXmlLines(prevXml, prevAnalysis);
    const currLines = formatXmlLines(currXml, currAnalysis);
    if (!prevLines || !currLines || prevLines.length + currLines.length > MAX_DIFF_LINES) return undefined;
    const { diff, tokenToLine } = buildEncodedLineDiff(prevLines, currLines);

    const lines: DiffLine[] = [];
    let previousLineNumber = 1;
    let currentLineNumber = 1;

    for (const [rawType, encodedText] of diff) {
        const type = DIFF_TYPE_MAP[rawType] ?? 'equal';

        for (const token of Array.from(encodedText)) {
            const text = tokenToLine.get(token) ?? '';

            if (type === 'equal') {
                lines.push({
                    type,
                    previousLineNumber,
                    currentLineNumber,
                    text,
                });
                previousLineNumber++;
                currentLineNumber++;
                continue;
            }

            if (type === 'delete') {
                lines.push({
                    type,
                    previousLineNumber,
                    currentLineNumber: null,
                    text,
                });
                previousLineNumber++;
                continue;
            }

            lines.push({
                type,
                previousLineNumber: null,
                currentLineNumber,
                text,
            });
            currentLineNumber++;
        }
    }

    return lines;
}

function buildDiffRows(lines: DiffLine[]): DiffRow[] {
    const rows: DiffRow[] = [];

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];

        if (line.type === 'equal') {
            rows.push({
                previousLineNumber: line.previousLineNumber,
                previousText: line.text,
                currentLineNumber: line.currentLineNumber,
                currentText: line.text,
            });
            continue;
        }

        const chunk: DiffLine[] = [line];
        while (index + 1 < lines.length && lines[index + 1].type !== 'equal') {
            chunk.push(lines[++index]);
        }

        const deleted = chunk.filter((entry) => entry.type === 'delete');
        const inserted = chunk.filter((entry) => entry.type === 'insert');
        const totalRows = Math.max(deleted.length, inserted.length);

        for (let chunkIndex = 0; chunkIndex < totalRows; chunkIndex++) {
            rows.push({
                previousLineNumber: deleted[chunkIndex]?.previousLineNumber ?? null,
                previousText: deleted[chunkIndex]?.text ?? null,
                currentLineNumber: inserted[chunkIndex]?.currentLineNumber ?? null,
                currentText: inserted[chunkIndex]?.text ?? null,
            });
        }
    }

    return rows;
}

export function computeDiffSummary(prevXml: string | undefined, currXml: string | undefined): DiffSummary | null {
    if (!prevXml || !currXml) return null;
    const prevAnalysis = analyzeXml(prevXml);
    const currAnalysis = analyzeXml(currXml);
    if (!prevAnalysis || !currAnalysis) return null;

    const lines = buildDiffLines(prevXml, currXml, prevAnalysis, currAnalysis);
    if (!lines) return null;
    const rows = buildDiffRows(lines);
    const prevElementCount = prevAnalysis.elementCount;
    const currElementCount = currAnalysis.elementCount;
    let insertedLineCount = 0;
    let deletedLineCount = 0;
    for (const line of lines) {
        if (line.type === 'insert') insertedLineCount++;
        else if (line.type === 'delete') deletedLineCount++;
    }

    return {
        rows,
        prevElementCount,
        currElementCount,
        elementCountDelta: currElementCount - prevElementCount,
        insertedLineCount,
        deletedLineCount,
        changedLineCount: insertedLineCount + deletedLineCount,
    };
}
