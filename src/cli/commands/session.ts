import { readFile } from 'node:fs/promises';
import { AppiumCommandClient } from '../../core/appium/client';
import { ensureNoUnexpectedFlags, expectOptionalString, expectStringFlag, parseFlags } from '../arg-parser';
import type { CommandExecutionResult } from './types';

export async function runSessionCreate(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['appium-url', 'caps-file', 'caps-json']);

    const appiumUrl = expectStringFlag('appium-url', parsed.flags['appium-url']);
    const capsFile = expectOptionalString(parsed.flags['caps-file']);
    const capsJson = expectOptionalString(parsed.flags['caps-json']);

    if ((capsFile && capsJson) || (!capsFile && !capsJson)) {
        throw new Error('Provide exactly one of --caps-file or --caps-json');
    }

    let capabilities: Record<string, unknown>;

    if (capsFile) {
        const raw = await readFile(capsFile, 'utf8');
        capabilities = JSON.parse(raw);
    } else {
        capabilities = JSON.parse(capsJson!);
    }

    const client = new AppiumCommandClient(appiumUrl);
    const session = await client.createSession(capabilities);

    return {
        command: 'session.create',
        result: {
            appiumUrl,
            sessionId: session.sessionId,
            value: session.value,
        },
    };
}

export async function runSessionDelete(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['appium-url', 'session-id']);

    const appiumUrl = expectStringFlag('appium-url', parsed.flags['appium-url']);
    const sessionId = expectStringFlag('session-id', parsed.flags['session-id']);

    const client = new AppiumCommandClient(appiumUrl);
    await client.deleteSession(sessionId);

    return {
        command: 'session.delete',
        result: {
            appiumUrl,
            sessionId,
            deleted: true,
        },
    };
}
