import { type Component, createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import type { ParsedElement } from '../types';
import { computeScale, elementToOverlayRect, renderedToSource, hitTest } from '../utils/element-geometry';
import type { ScaleFactor } from '../utils/element-geometry';

type ScreenshotOverlayProps = {
    screenshot: string;
    elements: ParsedElement[];
    selectedElement: ParsedElement | null;
    hoveredElement: ParsedElement | null;
    matchedElements: ParsedElement[];
    onElementSelect: (element: ParsedElement) => void;
    onElementHover: (element: ParsedElement | null) => void;
};

export const ScreenshotOverlay: Component<ScreenshotOverlayProps> = (props) => {
    const [scale, setScale] = createSignal<ScaleFactor>({ scaleX: 1, scaleY: 1 });
    const [imgRef, setImgRef] = createSignal<HTMLImageElement | undefined>();

    const updateScale = () => {
        const img = imgRef();
        if (!img || !img.naturalWidth || !img.naturalHeight) return;
        setScale(computeScale(img.clientWidth, img.clientHeight, img.naturalWidth, img.naturalHeight));
    };

    createEffect(() => {
        const img = imgRef();
        if (!img) return;

        img.addEventListener('load', updateScale);
        const observer = new ResizeObserver(updateScale);
        observer.observe(img);

        onCleanup(() => {
            img.removeEventListener('load', updateScale);
            observer.disconnect();
        });
    });

    const handleClick = (e: MouseEvent) => {
        const img = imgRef();
        if (!img) return;

        const rect = img.getBoundingClientRect();
        const renderedX = e.clientX - rect.left;
        const renderedY = e.clientY - rect.top;

        const sourcePoint = renderedToSource(renderedX, renderedY, scale());
        const hit = hitTest(sourcePoint.x, sourcePoint.y, props.elements);
        if (hit) {
            props.onElementSelect(hit);
        }
    };

    const handleMouseMove = (e: MouseEvent) => {
        const img = imgRef();
        if (!img) return;

        const rect = img.getBoundingClientRect();
        const renderedX = e.clientX - rect.left;
        const renderedY = e.clientY - rect.top;

        // Only detect hover when mouse is over the image
        if (renderedX < 0 || renderedY < 0 || renderedX > img.clientWidth || renderedY > img.clientHeight) {
            props.onElementHover(null);
            return;
        }

        const sourcePoint = renderedToSource(renderedX, renderedY, scale());
        const hit = hitTest(sourcePoint.x, sourcePoint.y, props.elements);
        props.onElementHover(hit);
    };

    const handleMouseLeave = () => {
        props.onElementHover(null);
    };

    const overlayStyle = (el: ParsedElement, type: 'selected' | 'hovered' | 'matched') => {
        const rect = elementToOverlayRect(el, scale());
        const colors = {
            selected: 'rgba(196, 104, 42, 0.35)',
            hovered: 'rgba(196, 104, 42, 0.2)',
            matched: 'rgba(45, 125, 79, 0.2)',
        };
        const borders = {
            selected: '2px solid rgba(196, 104, 42, 0.9)',
            hovered: '2px dashed rgba(196, 104, 42, 0.7)',
            matched: '1px solid rgba(45, 125, 79, 0.6)',
        };
        return {
            position: 'absolute' as const,
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            background: colors[type],
            border: borders[type],
            'border-radius': '2px',
            'pointer-events': 'none' as const,
            'box-sizing': 'border-box' as const,
        };
    };

    const isSelectedOrHovered = (el: ParsedElement) => {
        const sel = props.selectedElement;
        const hov = props.hoveredElement;
        return (sel && sel.xpath === el.xpath) || (hov && hov.xpath === el.xpath);
    };

    return (
        <div
            class="screenshot-overlay-container"
            onClick={handleClick}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
        >
            <img
                ref={setImgRef}
                src={`data:image/png;base64,${props.screenshot}`}
                alt="Screenshot"
                class="screenshot-image"
            />
            <div class="screenshot-overlay-rects">
                {/* Matched elements (lowest z-order) */}
                <For each={props.matchedElements.filter(el => !isSelectedOrHovered(el))}>
                    {(el) => <div style={overlayStyle(el, 'matched')} />}
                </For>

                {/* Hovered element */}
                <Show when={props.hoveredElement && props.hoveredElement !== props.selectedElement}>
                    <div style={overlayStyle(props.hoveredElement!, 'hovered')} />
                </Show>

                {/* Selected element (highest z-order) */}
                <Show when={props.selectedElement}>
                    <div style={overlayStyle(props.selectedElement!, 'selected')} />
                </Show>
            </div>
        </div>
    );
};
