import { AppiumCommandClient, MIN_GESTURE_DURATION_MS } from '../../core/appium/client';
import { ensureNoUnexpectedFlags, expectStringFlag, parseBooleanFlag, parseFlags, parseNumberFlag } from '../arg-parser';

const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];
import type { CommandExecutionResult } from './types';

function isScrollDirection(value: string): value is ScrollDirection {
    return SCROLL_DIRECTIONS.some(direction => direction === value);
}

function parsePoint(name: string, value: string): { x: number; y: number } {
    const parts = value.split(',');
    if (parts.length !== 2 || parts.some(part => !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(part))) {
        throw new Error(`--${name} must be in format x,y`);
    }
    const [xRaw, yRaw] = parts;
    const x = Number(xRaw);
    const y = Number(yRaw);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`--${name} must be in format x,y`);
    }

    return { x, y };
}

function parseDuration(value: string | boolean | undefined): number {
    if (typeof value === 'string' && !Number.isFinite(Number(value))) {
        throw new Error(`--duration-ms must be an integer of at least ${MIN_GESTURE_DURATION_MS}`);
    }
    const duration = parseNumberFlag('duration-ms', value) ?? 300;
    if (!Number.isInteger(duration) || duration < MIN_GESTURE_DURATION_MS) {
        throw new Error(`--duration-ms must be an integer of at least ${MIN_GESTURE_DURATION_MS}`);
    }
    return duration;
}

export async function runDriveTap(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['appium-url', 'session-id', 'using', 'value']);

    const appiumUrl = expectStringFlag('appium-url', parsed.flags['appium-url']);
    const sessionId = expectStringFlag('session-id', parsed.flags['session-id']);
    const using = expectStringFlag('using', parsed.flags.using);
    const value = expectStringFlag('value', parsed.flags.value);

    const client = new AppiumCommandClient(appiumUrl);
    await client.tap(sessionId, using, value);

    return {
        command: 'drive.tap',
        result: { sessionId, using, value, performed: true },
    };
}

export async function runDriveType(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['appium-url', 'session-id', 'using', 'value', 'text', 'clear-first']);

    const appiumUrl = expectStringFlag('appium-url', parsed.flags['appium-url']);
    const sessionId = expectStringFlag('session-id', parsed.flags['session-id']);
    const using = expectStringFlag('using', parsed.flags.using);
    const value = expectStringFlag('value', parsed.flags.value);
    const text = expectStringFlag('text', parsed.flags.text);
    const clearFirst = parseBooleanFlag('clear-first', parsed.flags['clear-first']);

    const client = new AppiumCommandClient(appiumUrl);
    await client.type(sessionId, using, value, text, clearFirst);

    return {
        command: 'drive.type',
        result: { sessionId, using, value, textLength: text.length, clearFirst, performed: true },
    };
}

export async function runDriveBack(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['appium-url', 'session-id']);

    const appiumUrl = expectStringFlag('appium-url', parsed.flags['appium-url']);
    const sessionId = expectStringFlag('session-id', parsed.flags['session-id']);

    const client = new AppiumCommandClient(appiumUrl);
    await client.back(sessionId);

    return {
        command: 'drive.back',
        result: { sessionId, performed: true },
    };
}

export async function runDriveSwipe(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['appium-url', 'session-id', 'from', 'to', 'duration-ms']);

    const appiumUrl = expectStringFlag('appium-url', parsed.flags['appium-url']);
    const sessionId = expectStringFlag('session-id', parsed.flags['session-id']);
    const from = parsePoint('from', expectStringFlag('from', parsed.flags.from));
    const to = parsePoint('to', expectStringFlag('to', parsed.flags.to));
    const durationMs = parseDuration(parsed.flags['duration-ms']);

    const client = new AppiumCommandClient(appiumUrl);
    await client.swipe(sessionId, from, to, durationMs);

    return {
        command: 'drive.swipe',
        result: {
            sessionId,
            from,
            to,
            durationMs,
            performed: true,
        },
    };
}

export async function runDriveScroll(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['appium-url', 'session-id', 'direction', 'duration-ms']);

    const appiumUrl = expectStringFlag('appium-url', parsed.flags['appium-url']);
    const sessionId = expectStringFlag('session-id', parsed.flags['session-id']);
    const direction = expectStringFlag('direction', parsed.flags.direction);
    const durationMs = parseDuration(parsed.flags['duration-ms']);

    if (!isScrollDirection(direction)) {
        throw new Error(`--direction must be one of: ${SCROLL_DIRECTIONS.join(', ')}`);
    }

    const client = new AppiumCommandClient(appiumUrl);
    await client.scroll(sessionId, direction, durationMs);

    return {
        command: 'drive.scroll',
        result: {
            sessionId,
            direction,
            durationMs,
            performed: true,
        },
    };
}
