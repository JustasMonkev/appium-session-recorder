import { open } from 'node:fs/promises';
import { AppiumCommandClient } from '../../core/appium/client';
import { ensureNoUnexpectedFlags, expectOptionalString, expectStringFlag, parseFlags } from '../arg-parser';
import type { CommandExecutionResult } from './types';

const MAX_CAPABILITIES_BYTES = 10 * 1024 * 1024;

async function readCapabilitiesFile(file: string): Promise<string> {
    const handle = await open(file, 'r');
    try {
        if ((await handle.stat()).size > MAX_CAPABILITIES_BYTES) {
            throw new Error('Capabilities exceed 10 MiB');
        }

        const chunks: Buffer[] = [];
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) break;
            position += bytesRead;
            if (position > MAX_CAPABILITIES_BYTES) throw new Error('Capabilities exceed 10 MiB');
            chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        return Buffer.concat(chunks, position).toString('utf8');
    } finally {
        await handle.close();
    }
}

export async function runSessionCreate(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['appium-url', 'caps-file', 'caps-json']);

    const appiumUrl = expectStringFlag('appium-url', parsed.flags['appium-url']);
    const capsFile = expectOptionalString('caps-file', parsed.flags['caps-file']);
    const capsJson = expectOptionalString('caps-json', parsed.flags['caps-json']);

    let rawCapabilities: string;
    if (capsFile && !capsJson) {
        rawCapabilities = await readCapabilitiesFile(capsFile);
    } else if (capsJson && !capsFile) {
        rawCapabilities = capsJson;
    } else {
        throw new Error('Provide exactly one of --caps-file or --caps-json');
    }
    if (Buffer.byteLength(rawCapabilities) > MAX_CAPABILITIES_BYTES) {
        throw new Error('Capabilities exceed 10 MiB');
    }
    const capabilities: unknown = JSON.parse(rawCapabilities);

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
