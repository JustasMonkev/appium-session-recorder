export type Platform = 'ios' | 'android' | 'unknown';

export type SelectorStrategy =
    | 'accessibility id'
    | 'id'
    | 'xpath'
    | 'class name'
    | '-ios predicate string'
    | '-ios class chain'
    | '-android uiautomator';

export type SelectorReason =
    | 'BASE_STRATEGY_PRIORITY'
    | 'UNIQUE_MATCH'
    | 'MULTIPLE_MATCHES'
    | 'NO_MATCH'
    | 'VALID_MATCH'
    | 'ACTIONABLE_ELEMENT_BONUS'
    | 'DYNAMIC_TOKEN_PENALTY'
    | 'FRAGILE_XPATH_PENALTY';

export type ParsedElement = {
    elementRef: string;
    index: number;
    platform: Platform;
    type: string;
    xpath: string;
    name: string;
    label: string;
    value: string;
    text: string;
    resourceId: string;
    contentDesc: string;
    enabled: boolean;
    visible: boolean;
    accessible: boolean;
    clickable: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    attributes: Record<string, string>;
};

export type SelectorCandidate = {
    strategy: SelectorStrategy;
    value: string;
    platform: Platform | 'generic';
};

export type RankedSelector = SelectorCandidate & {
    score: number;
    matchCount: number;
    reasons: SelectorReason[];
};

export type ParsedSource = {
    platform: Platform;
    elements: ParsedElement[];
};

export type CommandError = {
    code: string;
    message: string;
    details?: unknown;
};

export type CommandResponse<T = unknown> = {
    ok: boolean;
    command: string;
    timestamp: string;
    result?: T;
    error?: CommandError;
};

export type Point = {
    x: number;
    y: number;
};
