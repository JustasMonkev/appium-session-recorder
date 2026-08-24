import { type Component, Show, createMemo } from 'solid-js';
import type { Interaction } from '../types';
import './ActionCarousel.css';

type ActionCarouselProps = {
    actions: Interaction[];
    currentIndex: number;
    onNavigate: (index: number) => void;
};

export const ActionCarousel: Component<ActionCarouselProps> = (props) => {
    const currentAction = createMemo(() => props.actions[props.currentIndex]);
    const total = () => props.actions.length;

    const goToPrevious = () => {
        if (props.currentIndex > 0) {
            props.onNavigate(props.currentIndex - 1);
        }
    };

    const goToNext = () => {
        if (props.currentIndex < total() - 1) {
            props.onNavigate(props.currentIndex + 1);
        }
    };

    const formattedTime = () => {
        const action = currentAction();
        return action ? new Date(action.timestamp).toLocaleTimeString() : '';
    };

    return (
        <div class="carousel">
            <Show
                when={total() > 0}
                fallback={
                    <div class="carousel-empty">
                        <span class="carousel-empty-icon">📱</span>
                        <span>No actions recorded yet. Connect an Appium client to this recorder and start interacting.</span>
                    </div>
                }
            >
                <button
                    class="carousel-btn"
                    onClick={goToPrevious}
                    disabled={props.currentIndex === 0}
                >
                    ← Previous
                </button>

                <div class="carousel-info">
                    <div class="carousel-counter">
                        Action {props.currentIndex + 1} of {total()}
                    </div>
                    <Show when={currentAction()}>
                        <div class="carousel-details">
                            <span class="carousel-id">#{currentAction()!.id}</span>
                            <span classList={{
                                'carousel-method': true,
                                [currentAction()!.method]: true
                            }}>
                                {currentAction()!.method}
                            </span>
                            <span class="carousel-path">{currentAction()!.path}</span>
                            <span class="carousel-time">{formattedTime()}</span>
                            <Show when={!currentAction()!.screenshotUrl}>
                                <span class="carousel-capture">
                                    capture {currentAction()!.captureStatus ?? 'unavailable'}
                                </span>
                            </Show>
                        </div>
                        <Show when={currentAction()!.elementInfo}>
                            <div class="carousel-element">
                                <span class="carousel-element-using">{currentAction()!.elementInfo!.using}:</span>
                                {' "'}
                                <span class="carousel-element-value">{currentAction()!.elementInfo!.value}</span>
                                {'"'}
                            </div>
                        </Show>
                    </Show>
                </div>

                <button
                    class="carousel-btn"
                    onClick={goToNext}
                    disabled={props.currentIndex === total() - 1}
                >
                    Next →
                </button>
            </Show>
        </div>
    );
};
