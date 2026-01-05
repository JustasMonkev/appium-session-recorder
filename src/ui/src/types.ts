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
