import { type Component, For, createSignal, createMemo } from 'solid-js';
import type { ParsedElement } from '../types';

type TreeNode = {
    element: ParsedElement;
    children: TreeNode[];
    depth: number;
};

type ElementTreeProps = {
    elements: ParsedElement[];
    selectedElement: ParsedElement | null;
    onElementSelect: (element: ParsedElement) => void;
    onElementHover: (element: ParsedElement | null) => void;
};

/**
 * Build a tree structure from a flat list of parsed elements using xpath hierarchy.
 */
function buildTree(elements: ParsedElement[]): TreeNode[] {
    if (elements.length === 0) return [];

    const roots: TreeNode[] = [];
    const nodeMap = new Map<string, TreeNode>();

    for (const el of elements) {
        const node: TreeNode = { element: el, children: [], depth: el.xpath.split('/').length - 2 };
        nodeMap.set(el.xpath, node);

        // Find parent xpath by removing the last segment
        const lastSlash = el.xpath.lastIndexOf('/');
        const parentXpath = lastSlash > 0 ? el.xpath.substring(0, lastSlash) : '';
        const parent = nodeMap.get(parentXpath);

        if (parent) {
            parent.children.push(node);
        } else {
            roots.push(node);
        }
    }

    return roots;
}

function displayName(el: ParsedElement): string {
    const parts = [el.type];
    if (el.name) parts.push(`name="${el.name}"`);
    else if (el.label) parts.push(`label="${el.label}"`);
    return parts.join(' ');
}

const TreeNodeRow: Component<{
    node: TreeNode;
    selectedElement: ParsedElement | null;
    collapsedPaths: Set<string>;
    onToggle: (xpath: string) => void;
    onElementSelect: (element: ParsedElement) => void;
    onElementHover: (element: ParsedElement | null) => void;
}> = (props) => {
    const isSelected = () => props.selectedElement?.xpath === props.node.element.xpath;
    const isCollapsed = () => props.collapsedPaths.has(props.node.element.xpath);
    const hasChildren = () => props.node.children.length > 0;

    return (
        <>
            <div
                class="element-tree-row"
                classList={{
                    'element-tree-row--selected': isSelected(),
                    'element-tree-row--no-children': !hasChildren(),
                }}
                style={{ 'padding-left': `${props.node.depth * 16 + 8}px` }}
                onClick={() => props.onElementSelect(props.node.element)}
                onMouseEnter={() => props.onElementHover(props.node.element)}
                onMouseLeave={() => props.onElementHover(null)}
            >
                {hasChildren() && (
                    <button
                        type="button"
                        class="element-tree-toggle"
                        classList={{ 'element-tree-toggle--collapsed': isCollapsed() }}
                        aria-label={isCollapsed() ? 'Expand child elements' : 'Collapse child elements'}
                        aria-expanded={!isCollapsed()}
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onToggle(props.node.element.xpath);
                        }}
                    >
                        <span aria-hidden="true">▶</span>
                    </button>
                )}
                <span class="element-tree-label">{displayName(props.node.element)}</span>
            </div>
            {!isCollapsed() && (
                <For each={props.node.children}>
                    {(child) => (
                        <TreeNodeRow
                            node={child}
                            selectedElement={props.selectedElement}
                            collapsedPaths={props.collapsedPaths}
                            onToggle={props.onToggle}
                            onElementSelect={props.onElementSelect}
                            onElementHover={props.onElementHover}
                        />
                    )}
                </For>
            )}
        </>
    );
};

export const ElementTree: Component<ElementTreeProps> = (props) => {
    const [collapsedPaths, setCollapsedPaths] = createSignal<Set<string>>(new Set());

    const tree = createMemo(() => buildTree(props.elements));

    const toggleNode = (xpath: string) => {
        setCollapsedPaths((prev) => {
            const next = new Set(prev);
            if (next.has(xpath)) {
                next.delete(xpath);
            } else {
                next.add(xpath);
            }
            return next;
        });
    };

    return (
        <div class="element-tree">
            <h3 class="section-title">Element Tree</h3>
            <div class="element-tree-list">
                <For each={tree()}>
                    {(node) => (
                        <TreeNodeRow
                            node={node}
                            selectedElement={props.selectedElement}
                            collapsedPaths={collapsedPaths()}
                            onToggle={toggleNode}
                            onElementSelect={props.onElementSelect}
                            onElementHover={props.onElementHover}
                        />
                    )}
                </For>
            </div>
        </div>
    );
};
