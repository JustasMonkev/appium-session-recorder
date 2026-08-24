import * as p from '@clack/prompts';
import { validateHost, validatePort, validateUrl } from './arg-parser';
import { DEFAULT_RECORDER_OPTIONS, type RecorderOptions } from '../server/types';

export async function runPrompts(defaults = DEFAULT_RECORDER_OPTIONS): Promise<RecorderOptions> {
    console.clear();

    p.intro('🎬 Appium Session Recorder');

    const answers = await p.group(
        {
            port: () => p.text({
                message: `Proxy port (default: ${defaults.port}):`,
                placeholder: String(defaults.port),
                defaultValue: String(defaults.port),
                validate: (value) => value === undefined ? undefined : validatePort(value),
            }),
            host: () => p.text({
                message: `Proxy host (default: ${defaults.host}):`,
                placeholder: defaults.host,
                defaultValue: defaults.host,
                validate: (value) => value === undefined ? undefined : validateHost(value),
            }),
            appiumUrl: () => p.text({
                message: `Appium server URL (default: ${defaults.appiumUrl}):`,
                placeholder: defaults.appiumUrl,
                defaultValue: defaults.appiumUrl,
                validate: (value) => value === undefined ? undefined : validateUrl(value),
            }),
        },
        {
            onCancel: () => {
                p.cancel('Operation cancelled.');
                process.exit(0);
            },
        }
    );

    const port = typeof answers.port === 'string' ? answers.port : String(defaults.port);
    const host = typeof answers.host === 'string' ? answers.host : defaults.host;
    const appiumUrl = typeof answers.appiumUrl === 'string' ? answers.appiumUrl : defaults.appiumUrl;
    return { port: Number(port), host: host.trim(), appiumUrl: appiumUrl.trim() };
}
