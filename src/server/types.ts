export type RecorderOptions = {
    appiumUrl?: string;
    host?: string;
    port?: number;
};

export type ElementInfo = {
    using: string;
    value: string;
};

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
    screenshotUrl?: string;  // served by /_recorder/api/screenshot/:id
    source?: string;         // XML
    elementInfo?: ElementInfo;
    sessionId?: string;
    actionKind?: ActionKind;
};

export type CapturedState = {
    screenshot?: string | null;  // base64 PNG from Appium
    source?: string | null;      // XML
};

export type AppiumResponse = {
    value: any;
    sessionId?: string;
    status?: number;
};

export type ServerEvent =
    | { type: 'interaction'; data: Interaction }
    | { type: 'clear'; data: null }
    // Emitted when old interactions are evicted by the history cap so
    // connected clients can drop them too.
    | { type: 'evict'; data: { ids: number[] } };

export type ServerEventType = ServerEvent['type'];
