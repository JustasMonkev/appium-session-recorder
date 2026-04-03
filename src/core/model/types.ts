export type MobileFunction = {
    name: string;
    description: string;
    parameters: MobileFunctionParameter[];
};

export type MobileFunctionParameter = {
    name: string;
    type: 'string' | 'number' | 'boolean';
    description: string;
    required: boolean;
};

export type PredictedAction = {
    functionName: string;
    arguments: Record<string, string | number | boolean>;
    raw: string;
};

export type ModelConfig = {
    modelPath: string;
    litertBinaryPath: string;
    maxTokens: number;
    topK: number;
    temperature: number;
};

export type ModelSetupResult = {
    modelPath: string;
    modelSize: number;
    litertBinaryPath: string | null;
    ready: boolean;
};

export type PredictionResult = {
    query: string;
    action: PredictedAction | null;
    rawOutput: string;
    durationMs: number;
};

export type ExecuteResult = {
    query: string;
    prediction: PredictedAction;
    appiumActions: AppiumActionStep[];
    success: boolean;
};

export type AppiumActionStep = {
    action: 'tap' | 'type' | 'clear' | 'back' | 'swipe' | 'scroll';
    using?: string;
    value?: string;
    text?: string;
    performed: boolean;
    error?: string;
};

export const DEFAULT_MOBILE_FUNCTIONS: MobileFunction[] = [
    {
        name: 'tap',
        description: 'Tap on a UI element identified by accessibility label or text',
        parameters: [
            { name: 'element', type: 'string', description: 'The accessibility label, text, or identifier of the element to tap', required: true },
        ],
    },
    {
        name: 'type_text',
        description: 'Type text into a text field identified by accessibility label',
        parameters: [
            { name: 'element', type: 'string', description: 'The accessibility label or identifier of the text field', required: true },
            { name: 'text', type: 'string', description: 'The text to type', required: true },
        ],
    },
    {
        name: 'scroll',
        description: 'Scroll the screen in a direction',
        parameters: [
            { name: 'direction', type: 'string', description: 'Direction to scroll: up, down, left, or right', required: true },
        ],
    },
    {
        name: 'go_back',
        description: 'Navigate back to the previous screen',
        parameters: [],
    },
    {
        name: 'swipe',
        description: 'Swipe from one point to another',
        parameters: [
            { name: 'from_x', type: 'number', description: 'Starting X coordinate', required: true },
            { name: 'from_y', type: 'number', description: 'Starting Y coordinate', required: true },
            { name: 'to_x', type: 'number', description: 'Ending X coordinate', required: true },
            { name: 'to_y', type: 'number', description: 'Ending Y coordinate', required: true },
        ],
    },
    {
        name: 'clear_field',
        description: 'Clear a text field',
        parameters: [
            { name: 'element', type: 'string', description: 'The accessibility label or identifier of the text field to clear', required: true },
        ],
    },
    {
        name: 'create_contact',
        description: 'Create a new contact on the device',
        parameters: [
            { name: 'first_name', type: 'string', description: 'First name of the contact', required: true },
            { name: 'last_name', type: 'string', description: 'Last name of the contact', required: false },
            { name: 'phone_number', type: 'string', description: 'Phone number', required: false },
            { name: 'email', type: 'string', description: 'Email address', required: false },
        ],
    },
    {
        name: 'create_calendar_event',
        description: 'Create a new calendar event',
        parameters: [
            { name: 'title', type: 'string', description: 'Event title', required: true },
            { name: 'start_time', type: 'string', description: 'Start time in ISO format', required: true },
            { name: 'end_time', type: 'string', description: 'End time in ISO format', required: false },
            { name: 'location', type: 'string', description: 'Event location', required: false },
        ],
    },
    {
        name: 'turn_on_flashlight',
        description: 'Turn on the device flashlight',
        parameters: [],
    },
    {
        name: 'turn_off_flashlight',
        description: 'Turn off the device flashlight',
        parameters: [],
    },
];
