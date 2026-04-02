export type ActionKind =
    | 'tap'
    | 'type'
    | 'clear'
    | 'back'
    | 'swipe'
    | 'scroll'
    | 'find'
    | 'unknown';

export type Interaction = {
    id: number;
    timestamp: string;
    method: string;
    path: string;
    body?: any;
    screenshot?: string;
    source?: string;
    elementInfo?: {
        using: string;
        value: string;
    };
    sessionId?: string;
    actionKind?: ActionKind;
};

export type ParsedElement = {
    type: string;
    name: string;
    label: string;
    value: string;
    enabled: boolean;
    visible: boolean;
    accessible: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    xpath: string;
    node: Element;
};

export type Locator = {
    strategy: string;
    value: string;
};

export type DiffSegment = {
    type: 'equal' | 'insert' | 'delete';
    text: string;
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
    segments: DiffSegment[];
    lines: DiffLine[];
    rows: DiffRow[];
    prevElementCount: number;
    currElementCount: number;
    elementCountDelta: number;
    insertedLineCount: number;
    deletedLineCount: number;
    changedLineCount: number;
};
