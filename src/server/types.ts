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
    screenshot?: string;  // base64
    source?: string;      // XML
    elementInfo?: ElementInfo;
    sessionId?: string;
    actionKind?: ActionKind;
};

export type ReplayRequest = {
    sessionId: string;
    selector?: { using: string; value: string };
    text?: string;
    direction?: 'up' | 'down' | 'left' | 'right';
    from?: { x: number; y: number };
    to?: { x: number; y: number };
    durationMs?: number;
};

export type ReplayResult = {
    ok: boolean;
    interactionId: number;
    actionKind: ActionKind;
    error?: string;
};

export type AppiumResponse = {
    value: any;
    sessionId?: string;
    status?: number;
};

export type ServerEventType = 'interaction' | 'clear';

export type ServerEvent = {
    type: ServerEventType;
    data: Interaction | null;
};
