import { AppiumCommandClient } from '../appium/client';
import type { AppiumActionStep, ExecuteResult, PredictedAction } from './types';

export async function executeActions(
    client: AppiumCommandClient,
    sessionId: string,
    prediction: PredictedAction,
    steps: AppiumActionStep[],
): Promise<ExecuteResult> {
    const executedSteps: AppiumActionStep[] = [];
    let allSuccess = true;

    for (const step of steps) {
        const executed = { ...step };

        try {
            switch (step.action) {
                case 'tap': {
                    await client.tap(sessionId, step.using!, step.value!);
                    executed.performed = true;
                    break;
                }

                case 'type': {
                    await client.type(sessionId, step.using!, step.value!, step.text!, false);
                    executed.performed = true;
                    break;
                }

                case 'clear': {
                    await client.clear(sessionId, step.using!, step.value!);
                    executed.performed = true;
                    break;
                }

                case 'back': {
                    await client.back(sessionId);
                    executed.performed = true;
                    break;
                }

                case 'scroll': {
                    const dir = step.value as 'up' | 'down' | 'left' | 'right';
                    await client.scroll(sessionId, dir);
                    executed.performed = true;
                    break;
                }

                case 'swipe': {
                    const coords = JSON.parse(step.value!);
                    await client.swipe(sessionId, coords.from, coords.to, 300);
                    executed.performed = true;
                    break;
                }
            }
        } catch (err) {
            executed.performed = false;
            executed.error = err instanceof Error ? err.message : String(err);
            allSuccess = false;
        }

        executedSteps.push(executed);

        if (!executed.performed) break;
    }

    return {
        query: '',
        prediction,
        appiumActions: executedSteps,
        success: allSuccess,
    };
}
