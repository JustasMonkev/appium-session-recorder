import { AppiumCommandClient } from '../../core/appium/client';
import { parseSource } from '../../core/xml/parse-source';
import { ensureNoUnexpectedFlags, expectStringFlag, parseFlags, parseNumberFlag } from '../arg-parser';
import type { CommandExecutionResult } from './types';

export async function runScreenSnapshot(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['appium-url', 'session-id']);

    const appiumUrl = expectStringFlag('appium-url', parsed.flags['appium-url']);
    const sessionId = expectStringFlag('session-id', parsed.flags['session-id']);

    const client = new AppiumCommandClient(appiumUrl);
    const { source, screenshot } = await client.captureState(sessionId);
    const parsedSource = parseSource(source);

    return {
        command: 'screen.snapshot',
        result: {
            sessionId,
            platform: parsedSource.platform,
            screenshot,
            source,
            metadata: {
                elementCount: parsedSource.elements.length,
            },
        },
    };
}

export async function runScreenElements(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['appium-url', 'session-id', 'limit', 'only-actionable']);

    const appiumUrl = expectStringFlag('appium-url', parsed.flags['appium-url']);
    const sessionId = expectStringFlag('session-id', parsed.flags['session-id']);
    const limit = parseNumberFlag('limit', parsed.flags.limit);
    const onlyActionable = parsed.flags['only-actionable'] === true;

    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new Error('--limit must be a positive integer');
    }

    const client = new AppiumCommandClient(appiumUrl);
    const source = await client.getSource(sessionId);
    const parsedSource = parseSource(source);

    let elements = parsedSource.elements;
    if (onlyActionable) {
        elements = elements.filter(element => element.enabled && element.visible && (element.clickable || element.accessible));
    }
    if (limit !== undefined) {
        elements = elements.slice(0, limit);
    }

    return {
        command: 'screen.elements',
        result: {
            sessionId,
            platform: parsedSource.platform,
            total: parsedSource.elements.length,
            returned: elements.length,
            onlyActionable,
            elements,
        },
    };
}
