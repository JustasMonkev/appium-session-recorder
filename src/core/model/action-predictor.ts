import { buildPrompt, runInference } from './litert-runner';
import type {
    AppiumActionStep,
    MobileFunction,
    ModelConfig,
    PredictedAction,
    PredictionResult,
} from './types';

function formatFunctionDeclarations(functions: MobileFunction[]): string {
    return functions
        .map((fn) => {
            const params = fn.parameters
                .map((p) => `${p.name}: ${p.type}${p.required ? '' : ' (optional)'}`)
                .join(', ');
            return `- ${fn.name}(${params}): ${fn.description}`;
        })
        .join('\n');
}

export function parseFunctionCall(raw: string): PredictedAction | null {
    const startTag = '<start_function_call>';
    const endTag = '<end_function_call>';

    const startIdx = raw.indexOf(startTag);
    const endIdx = raw.indexOf(endTag);

    if (startIdx === -1) return null;

    const inner = endIdx === -1
        ? raw.slice(startIdx + startTag.length).trim()
        : raw.slice(startIdx + startTag.length, endIdx).trim();

    const callMatch = inner.match(/^call:(\w+)\{(.*)\}$/s);
    if (!callMatch) {
        const noArgMatch = inner.match(/^call:(\w+)$/);
        if (noArgMatch) {
            return {
                functionName: noArgMatch[1],
                arguments: {},
                raw: inner,
            };
        }
        return null;
    }

    const functionName = callMatch[1];
    const argsStr = callMatch[2];

    const args: Record<string, string | number | boolean> = {};

    const argPairs = argsStr.match(/(\w+)\s*:\s*("(?:[^"\\]|\\.)*"|[\w.+-]+)/g);
    if (argPairs) {
        for (const pair of argPairs) {
            const colonIdx = pair.indexOf(':');
            const key = pair.slice(0, colonIdx).trim();
            let val: string = pair.slice(colonIdx + 1).trim();

            if (val.startsWith('"') && val.endsWith('"')) {
                val = val.slice(1, -1).replace(/\\"/g, '"');
            }

            const numVal = Number(val);
            if (!isNaN(numVal) && val !== '') {
                args[key] = numVal;
            } else if (val === 'true') {
                args[key] = true;
            } else if (val === 'false') {
                args[key] = false;
            } else {
                args[key] = val;
            }
        }
    }

    return { functionName, arguments: args, raw: inner };
}

export async function predictAction(
    query: string,
    functions: MobileFunction[],
    config?: Partial<ModelConfig>,
): Promise<PredictionResult> {
    const declarations = formatFunctionDeclarations(functions);
    const prompt = buildPrompt(query, declarations);

    const start = Date.now();
    const rawOutput = await runInference(prompt, config);
    const durationMs = Date.now() - start;

    const action = parseFunctionCall(rawOutput);

    return { query, action, rawOutput, durationMs };
}

export function mapToAppiumActions(
    prediction: PredictedAction,
    elements?: Array<{ name: string; label: string; type: string }>,
): AppiumActionStep[] {
    const { functionName, arguments: args } = prediction;

    switch (functionName) {
        case 'tap': {
            const element = String(args.element || '');
            return [
                {
                    action: 'tap',
                    using: 'accessibility id',
                    value: element,
                    performed: false,
                },
            ];
        }

        case 'type_text': {
            const element = String(args.element || '');
            const text = String(args.text || '');
            return [
                {
                    action: 'tap',
                    using: 'accessibility id',
                    value: element,
                    performed: false,
                },
                {
                    action: 'type',
                    using: 'accessibility id',
                    value: element,
                    text,
                    performed: false,
                },
            ];
        }

        case 'clear_field': {
            const element = String(args.element || '');
            return [
                {
                    action: 'clear',
                    using: 'accessibility id',
                    value: element,
                    performed: false,
                },
            ];
        }

        case 'scroll': {
            const direction = String(args.direction || 'down');
            return [
                {
                    action: 'scroll',
                    value: direction,
                    performed: false,
                },
            ];
        }

        case 'go_back': {
            return [
                {
                    action: 'back',
                    performed: false,
                },
            ];
        }

        case 'swipe': {
            return [
                {
                    action: 'swipe',
                    value: JSON.stringify({
                        from: { x: Number(args.from_x || 0), y: Number(args.from_y || 0) },
                        to: { x: Number(args.to_x || 0), y: Number(args.to_y || 0) },
                    }),
                    performed: false,
                },
            ];
        }

        case 'create_contact': {
            const steps: AppiumActionStep[] = [];
            steps.push({ action: 'tap', using: 'accessibility id', value: 'Contacts', performed: false });
            steps.push({ action: 'tap', using: 'accessibility id', value: 'Add', performed: false });

            if (args.first_name) {
                steps.push({ action: 'tap', using: 'accessibility id', value: 'First name', performed: false });
                steps.push({ action: 'type', using: 'accessibility id', value: 'First name', text: String(args.first_name), performed: false });
            }
            if (args.last_name) {
                steps.push({ action: 'tap', using: 'accessibility id', value: 'Last name', performed: false });
                steps.push({ action: 'type', using: 'accessibility id', value: 'Last name', text: String(args.last_name), performed: false });
            }
            if (args.phone_number) {
                steps.push({ action: 'tap', using: 'accessibility id', value: 'add phone', performed: false });
                steps.push({ action: 'type', using: 'accessibility id', value: 'Phone', text: String(args.phone_number), performed: false });
            }
            if (args.email) {
                steps.push({ action: 'tap', using: 'accessibility id', value: 'add email', performed: false });
                steps.push({ action: 'type', using: 'accessibility id', value: 'Email', text: String(args.email), performed: false });
            }

            steps.push({ action: 'tap', using: 'accessibility id', value: 'Done', performed: false });
            return steps;
        }

        case 'create_calendar_event': {
            const steps: AppiumActionStep[] = [];
            steps.push({ action: 'tap', using: 'accessibility id', value: 'Calendar', performed: false });
            steps.push({ action: 'tap', using: 'accessibility id', value: 'Add', performed: false });

            if (args.title) {
                steps.push({ action: 'tap', using: 'accessibility id', value: 'Title', performed: false });
                steps.push({ action: 'type', using: 'accessibility id', value: 'Title', text: String(args.title), performed: false });
            }
            if (args.location) {
                steps.push({ action: 'tap', using: 'accessibility id', value: 'Location', performed: false });
                steps.push({ action: 'type', using: 'accessibility id', value: 'Location', text: String(args.location), performed: false });
            }

            steps.push({ action: 'tap', using: 'accessibility id', value: 'Add', performed: false });
            return steps;
        }

        case 'turn_on_flashlight':
        case 'turn_off_flashlight': {
            return [
                {
                    action: 'swipe',
                    value: JSON.stringify({
                        from: { x: 200, y: 0 },
                        to: { x: 200, y: 400 },
                    }),
                    performed: false,
                },
                {
                    action: 'tap',
                    using: 'accessibility id',
                    value: 'Flashlight',
                    performed: false,
                },
            ];
        }

        default: {
            return [
                {
                    action: 'tap',
                    using: 'accessibility id',
                    value: functionName,
                    performed: false,
                    error: `Unknown function '${functionName}', attempting as element tap`,
                },
            ];
        }
    }
}
