export type RecorderOptions = {
    appiumUrl?: string;
    host?: string;
    port?: number;
};

export type ElementInfo = {
    using: string;
    value: string;
};

export type Interaction = {
    id: number;
    timestamp: string;
    method: string;
    path: string;
    body?: any;
    screenshot?: string;  // base64
    source?: string;      // XML
    elementInfo?: ElementInfo;
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
