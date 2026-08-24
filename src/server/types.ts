export type RecorderOptions = {
    appiumUrl?: string;
    host?: string;
    port?: number;
};

export const DEFAULT_RECORDER_OPTIONS: Required<RecorderOptions> = {
    appiumUrl: 'http://127.0.0.1:4723',
    host: '127.0.0.1',
    port: 4724,
};

export function httpHost(host: string): string {
    return host.includes(':') ? `[${host}]` : host;
}

export type ElementInfo = {
    using: string;
    value: string;
};

export type ActionKind =
    | 'tap'
    | 'type'
    | 'clear'
    | 'back'
    | 'forward'
    | 'refresh'
    | 'swipe'
    | 'find'
    | 'unknown';

export type Interaction = {
    id: number;
    timestamp: string;
    method: string;
    path: string;
    screenshotUrl?: string;
    source?: string;
    elementInfo?: ElementInfo;
    actionKind?: ActionKind;
    captureStatus?: 'pending' | 'complete' | 'partial' | 'failed' | 'skipped';
    detailsUrl?: string;
    detailsTruncated?: boolean;
};

export type CapturedState = {
    screenshot?: string | null;
    source?: string | null;
};

export type ServerEvent =
    | { type: 'interaction'; data: Interaction }
    | { type: 'clear'; data: null }
    | { type: 'evict'; data: { ids: number[] } };
