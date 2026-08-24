import { describe, expect, it } from 'vitest';
import { runProxyStart } from '../../src/cli/commands/proxy';

describe('proxy command boundaries', () => {
    it.each(['--host=', '--appium-url='])('rejects an explicitly empty optional flag: %s', async flag => {
        await expect(runProxyStart([flag])).rejects.toThrow('requires a non-empty value');
    });
});
