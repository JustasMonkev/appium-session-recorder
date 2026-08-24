import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
}> {
    const child = spawn('bun', ['run', 'src/index.ts', '--', ...args], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += String(chunk));
    child.stderr.on('data', chunk => stderr += String(chunk));
    const timeout = setTimeout(() => child.kill(), 2_000);
    const [exitCode] = await once(child, 'exit');
    clearTimeout(timeout);
    return { exitCode, stdout, stderr };
}

describe('legacy CLI process', () => {
    const servers: Server[] = [];

    afterEach(async () => {
        await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        })));
    });

    it('lets explicit flags override invalid environment values', async () => {
        const occupied = createServer();
        servers.push(occupied);
        occupied.listen(0, '127.0.0.1');
        await once(occupied, 'listening');
        const address = occupied.address();
        if (!address || typeof address === 'string') throw new Error('Expected an IP socket address');

        const result = await runCli([
            '--host', '127.0.0.1',
            '--port', String(address.port),
            '--appium-url', 'http://127.0.0.1:4723',
        ], {
            PROXY_PORT: 'invalid',
            PROXY_HOST: '0.0.0.0',
            APPIUM_URL: 'file:///tmp/appium.sock',
        });
        const output = result.stdout + result.stderr;

        expect(result.exitCode).toBe(1);
        expect(output).toContain('EADDRINUSE');
        expect(output).not.toContain('Invalid PROXY_');
        expect(output).not.toContain('Invalid APPIUM_URL');
    });

    it('emits one JSON error and exits nonzero in command mode', async () => {
        const result = await runCli(['screen', 'elements', '--session-id']);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toMatchObject({
            ok: false,
            command: 'screen.elements',
            error: { code: 'COMMAND_EXECUTION_ERROR' },
        });
    });

    it('executes a command against a real HTTP server and emits one JSON success', async () => {
        const upstream = createServer((_request, response) => {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({
                sessionId: 'process-session',
                value: { capabilities: { platformName: 'Android' } },
            }));
        });
        servers.push(upstream);
        upstream.listen(0, '127.0.0.1');
        await once(upstream, 'listening');
        const address = upstream.address();
        if (!address || typeof address === 'string') throw new Error('Expected an IP socket address');

        const result = await runCli([
            'session', 'create',
            '--appium-url', `http://127.0.0.1:${address.port}`,
            '--caps-json', '{"platformName":"Android"}',
        ]);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toMatchObject({
            ok: true,
            command: 'session.create',
            result: { sessionId: 'process-session' },
        });
    });
});
