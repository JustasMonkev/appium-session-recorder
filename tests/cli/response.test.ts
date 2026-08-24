import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitResponse, errorResponse, successResponse } from '../../src/cli/response';

describe('CLI responses', () => {
    const temporaryDirectories: string[] = [];

    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
            recursive: true,
            force: true,
        })));
    });

    it('creates timestamped success and error envelopes', () => {
        const success = successResponse('screen.elements', { total: 2 });
        const failure = errorResponse('screen.elements', 'INVALID', 'bad input', { flag: '--limit' });

        expect(success).toMatchObject({ ok: true, command: 'screen.elements', result: { total: 2 } });
        expect(failure).toMatchObject({
            ok: false,
            command: 'screen.elements',
            error: { code: 'INVALID', message: 'bad input', details: { flag: '--limit' } },
        });
        expect(Date.parse(success.timestamp)).not.toBeNaN();
        expect(Date.parse(failure.timestamp)).not.toBeNaN();
    });

    it('writes the output file without duplicating sensitive data to stdout', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'appium-recorder-response-'));
        temporaryDirectories.push(directory);
        const outputPath = join(directory, 'nested', 'response.json');
        const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        const response = successResponse('drive.back', { performed: true });

        await emitResponse(response, { pretty: true, output: outputPath });

        const file = await readFile(outputPath, 'utf8');
        expect(file).toBe(`${JSON.stringify(response, null, 2)}\n`);
        expect(stdout).not.toHaveBeenCalled();
    });

    it('does not claim success on stdout when the output file cannot be written', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'appium-recorder-response-'));
        temporaryDirectories.push(directory);
        const blocker = join(directory, 'blocker');
        await writeFile(blocker, 'not a directory');
        const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

        await expect(emitResponse(successResponse('drive.back', {}), {
            pretty: false,
            output: join(blocker, 'response.json'),
        })).rejects.toThrow();
        expect(stdout).not.toHaveBeenCalled();
    });

    it('waits for stdout backpressure to drain before resolving', async () => {
        vi.spyOn(process.stdout, 'write').mockReturnValue(false);
        let resolved = false;

        const emitted = emitResponse(successResponse('drive.back', {}), { pretty: false })
            .then(() => { resolved = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(resolved).toBe(false);

        process.stdout.emit('drain');
        await emitted;
        expect(resolved).toBe(true);
    });
});
