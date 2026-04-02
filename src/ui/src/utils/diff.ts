import fastDiff from 'fast-diff';
import type { DiffLine, DiffRow, DiffSegment, DiffSummary } from '../types';

const DIFF_TYPE_MAP: Record<number, DiffSegment['type']> = {
    [fastDiff.EQUAL]: 'equal',
    [fastDiff.INSERT]: 'insert',
    [fastDiff.DELETE]: 'delete',
};

function formatXmlLines(xml: string): string[] {
    const formatted: string[] = [];
    let indent = 0;
    const tokens = xml.replace(/></g, '>\n<').split('\n');

    for (const token of tokens) {
        const line = token.trim();
        if (!line) continue;

        if (line.startsWith('</')) {
            indent = Math.max(0, indent - 1);
            formatted.push(`${'  '.repeat(indent)}${line}`);
            continue;
        }

        if (line.startsWith('<?') || line.startsWith('<!--')) {
            formatted.push(`${'  '.repeat(indent)}${line}`);
            continue;
        }

        const isSelfClosing = line.endsWith('/>');
        const openTagMatch = line.match(/^<([^\s/>]+)(.*?)(\/?)>$/);

        if (!openTagMatch || line.includes('</')) {
            formatted.push(`${'  '.repeat(indent)}${line}`);
            continue;
        }

        const [, tagName, rawAttributes, selfClosingMarker] = openTagMatch;
        const attributes = Array.from(rawAttributes.matchAll(/([^\s=]+="[^"]*")/g)).map((match) => match[1]);
        const shouldSplitAttributes = attributes.length > 2 || line.length > 120;

        if (!shouldSplitAttributes || attributes.length === 0) {
            formatted.push(`${'  '.repeat(indent)}${line}`);
        } else {
            formatted.push(`${'  '.repeat(indent)}<${tagName}`);
            attributes.forEach((attribute) => {
                formatted.push(`${'  '.repeat(indent + 1)}${attribute}`);
            });
            formatted.push(`${'  '.repeat(indent)}${isSelfClosing || selfClosingMarker === '/' ? '/>' : '>'}`);
        }

        if (!isSelfClosing && selfClosingMarker !== '/') {
            indent++;
        }
    }

    return formatted;
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

function buildDiffLines(prevXml: string, currXml: string): DiffLine[] {
    const prevLines = formatXmlLines(prevXml);
    const currLines = formatXmlLines(currXml);
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

function groupDiffSegments(lines: DiffLine[]): DiffSegment[] {
    const segments: DiffSegment[] = [];

    for (const line of lines) {
        const text = `${line.text}\n`;
        const previous = segments[segments.length - 1];

        if (previous && previous.type === line.type) {
            previous.text += text;
            continue;
        }

        segments.push({
            type: line.type,
            text,
        });
    }

    return segments;
}

export function computeXmlDiff(prevXml: string, currXml: string): DiffSegment[] {
    return groupDiffSegments(buildDiffLines(prevXml, currXml));
}

function countElements(xml: string): number {
    // Count opening tags (not self-closing comments or processing instructions)
    const matches = xml.match(/<[a-zA-Z][^>]*>/g);
    return matches ? matches.length : 0;
}

export function computeDiffSummary(prevXml: string | undefined, currXml: string | undefined): DiffSummary | null {
    if (!prevXml || !currXml) return null;

    const lines = buildDiffLines(prevXml, currXml);
    const rows = buildDiffRows(lines);
    const segments = groupDiffSegments(lines);
    const prevElementCount = countElements(prevXml);
    const currElementCount = countElements(currXml);
    const insertedLineCount = lines.filter((line) => line.type === 'insert').length;
    const deletedLineCount = lines.filter((line) => line.type === 'delete').length;

    return {
        segments,
        lines,
        rows,
        prevElementCount,
        currElementCount,
        elementCountDelta: currElementCount - prevElementCount,
        insertedLineCount,
        deletedLineCount,
        changedLineCount: insertedLineCount + deletedLineCount,
    };
}
