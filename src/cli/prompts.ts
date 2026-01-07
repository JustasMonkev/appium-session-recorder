import * as p from '@clack/prompts';
import type { RecorderOptions } from '../server/types';

export async function runPrompts(): Promise<Partial<RecorderOptions>> {
    console.clear();

    p.intro('🎬 Appium Session Recorder');

    const answers = await p.group(
        {
            port: () => p.text({
                message: 'Proxy port:',
                initialValue: '4724',
                validate: (value) => {
                    const num = Number(value);
                    if (isNaN(num) || num < 1 || num > 65535) {
                        return 'Please enter a valid port number (1-65535)';
                    }
                },
            }),
            host: () => p.text({
                message: 'Proxy host:',
                initialValue: '127.0.0.1',
                validate: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Please enter a valid host';
                    }
                },
            }),
            appiumUrl: () => p.text({
                message: 'Appium server URL:',
                initialValue: 'http://127.0.0.1:4723',
                validate: (value) => {
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
        port: Number(answers.port),
        host: answers.host as string,
        appiumUrl: answers.appiumUrl as string,
    };
}
