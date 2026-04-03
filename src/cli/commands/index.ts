import { runDriveBack, runDriveScroll, runDriveSwipe, runDriveTap, runDriveType } from './drive';
import { runModelSetup, runModelPredict, runModelExecute } from './model';
import { runProxyStart } from './proxy';
import { runScreenElements, runScreenSnapshot } from './screen';
import { runSelectorsBest } from './selectors';
import { runSessionCreate, runSessionDelete } from './session';
import type { CommandExecutionResult } from './types';

export async function dispatchCommand(group: string, command: string, args: string[]): Promise<CommandExecutionResult> {
    if (group === 'proxy' && command === 'start') {
        return await runProxyStart(args);
    }

    if (group === 'session' && command === 'create') {
        return await runSessionCreate(args);
    }

    if (group === 'session' && command === 'delete') {
        return await runSessionDelete(args);
    }

    if (group === 'screen' && command === 'snapshot') {
        return await runScreenSnapshot(args);
    }

    if (group === 'screen' && command === 'elements') {
        return await runScreenElements(args);
    }

    if (group === 'selectors' && command === 'best') {
        return await runSelectorsBest(args);
    }

    if (group === 'drive' && command === 'tap') {
        return await runDriveTap(args);
    }

    if (group === 'drive' && command === 'type') {
        return await runDriveType(args);
    }

    if (group === 'drive' && command === 'back') {
        return await runDriveBack(args);
    }

    if (group === 'drive' && command === 'swipe') {
        return await runDriveSwipe(args);
    }

    if (group === 'drive' && command === 'scroll') {
        return await runDriveScroll(args);
    }

    if (group === 'model' && command === 'setup') {
        return await runModelSetup(args);
    }

    if (group === 'model' && command === 'predict') {
        return await runModelPredict(args);
    }

    if (group === 'model' && command === 'execute') {
        return await runModelExecute(args);
    }

    throw new Error(`Unsupported command: ${group} ${command}`);
}
