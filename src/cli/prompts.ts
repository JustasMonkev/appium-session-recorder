import * as p from '@clack/prompts';
import type {RecorderOptions} from '../server/types';

export async function runPrompts(): Promise<Partial<RecorderOptions>> {
    console.clear();

    p.intro('🎬 Appium Session Recorder');

    const defaults = {
        port: '4724',
        host: '127.0.0.1',
        appiumUrl: 'http://127.0.0.1:4723',
    } as const;

    const answers = await p.group(
        {
            port: () => p.text({
                message: `Proxy port (default: ${defaults.port}):`,
                placeholder: defaults.port,
                defaultValue: defaults.port,
                validate: (value) => {
                    if (!value || value.trim().length === 0) return;
                    const num = Number(value);
                    if (isNaN(num) || num < 1 || num > 65535) {
                        return 'Please enter a valid port number (1-65535)';
                    }
                },
            }),
            host: () => p.text({
                message: `Proxy host (default: ${defaults.host}):`,
                placeholder: defaults.host,
                defaultValue: defaults.host,
                validate: (value) => {
                    if (!value || value.trim().length === 0) return undefined;
                },
            }),
            appiumUrl: () => p.text({
                message: `Appium server URL (default: ${defaults.appiumUrl}):`,
                placeholder: defaults.appiumUrl,
                defaultValue: defaults.appiumUrl,
                validate: (value) => {
                    if (!value || value.trim().length === 0) return;
                    try {
                        new URL(value);
                    } catch {
                        return 'Please enter a valid URL';
                    }
                },
            }),
        },
        {
            onCancel: () => {
                p.cancel('Operation cancelled.');
                process.exit(0);
            },
        }
    );

    return {
        port: Number((answers.port as string) || defaults.port),
        host: ((answers.host as string) || defaults.host).trim(),
        appiumUrl: ((answers.appiumUrl as string) || defaults.appiumUrl).trim(),
    };
}
