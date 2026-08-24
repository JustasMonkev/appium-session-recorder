import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSessionCreate, runSessionDelete } from '../../src/cli/commands/session';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('session commands', () => {
    const temporaryDirectories: string[] = [];

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(async () => {
        await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
            recursive: true,
            force: true,
        })));
    });

    it('creates session from inline capabilities', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            jsonResponse({
                sessionId: 'abc123',
                value: { capabilities: { platformName: 'iOS' } },
            }),
        );

        const result = await runSessionCreate([
            '--appium-url', 'http://127.0.0.1:4723',
            '--caps-json', '{"platformName":"iOS","appium:automationName":"XCUITest"}',
        ]);

        expect(result.command).toBe('session.create');
        expect(result.result).toMatchObject({ sessionId: 'abc123' });

        const [, options] = fetchMock.mock.calls[0];
        const payload = JSON.parse(String(options?.body));
        expect(payload.capabilities.alwaysMatch.platformName).toBe('iOS');
    });

    it('deletes existing session', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ value: null }));

        const result = await runSessionDelete([
            '--appium-url', 'http://127.0.0.1:4723',
            '--session-id', 'abc123',
        ]);

        expect(result.command).toBe('session.delete');
        expect(result.result).toMatchObject({ deleted: true });

        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:4723/session/abc123',
            expect.objectContaining({ method: 'DELETE' }),
        );
    });

    it.each(['null', '[]', '"iOS"', '1', 'true'])('rejects non-object capabilities %s', async capsJson => {
        const fetchMock = vi.spyOn(globalThis, 'fetch');

        await expect(runSessionCreate([
            '--appium-url', 'http://127.0.0.1:4723',
            '--caps-json', capsJson,
        ])).rejects.toMatchObject({ code: 'INVALID_CAPABILITIES' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('requires exactly one capabilities source', async () => {
        await expect(runSessionCreate([
            '--appium-url', 'http://127.0.0.1:4723',
        ])).rejects.toThrow('Provide exactly one');

        await expect(runSessionCreate([
            '--appium-url', 'http://127.0.0.1:4723',
            '--caps-file', 'caps.json',
            '--caps-json', '{}',
        ])).rejects.toThrow('Provide exactly one');
    });

    it('reports malformed JSON without contacting Appium', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch');

        await expect(runSessionCreate([
            '--appium-url', 'http://127.0.0.1:4723',
            '--caps-json', '{broken',
        ])).rejects.toBeInstanceOf(SyntaxError);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a capabilities file larger than 10 MiB before contacting Appium', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'appium-recorder-caps-'));
        temporaryDirectories.push(directory);
        const file = join(directory, 'caps.json');
        await writeFile(file, '{}');
        await truncate(file, 10 * 1024 * 1024 + 1);
        const fetchMock = vi.spyOn(globalThis, 'fetch');

        await expect(runSessionCreate([
            '--appium-url', 'http://127.0.0.1:4723',
            '--caps-file', file,
        ])).rejects.toThrow('Capabilities exceed 10 MiB');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
