import type { ParsedElement as CoreParsedElement } from '../../core/types';
import type { Interaction as ServerInteraction } from '../../server/types';

export type Interaction = ServerInteraction;

export type ParsedElement = CoreParsedElement & {
    node: Element;
};

export type DiffLine = {
    type: 'equal' | 'insert' | 'delete';
    previousLineNumber: number | null;
    currentLineNumber: number | null;
    text: string;
};

export type DiffRow = {
    previousLineNumber: number | null;
    previousText: string | null;
    currentLineNumber: number | null;
    currentText: string | null;
};

export type DiffSummary = {
    rows: DiffRow[];
    prevElementCount: number;
    currElementCount: number;
    elementCountDelta: number;
    insertedLineCount: number;
    deletedLineCount: number;
    changedLineCount: number;
};
