import {
	type Component,
	type ComponentMouseEvent,
	Container,
	getKeybindings,
	Shimmer,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { BonsaiExecutionTreeNode, BonsaiTreeStatus } from "../../../core/bonsai/execution-tree.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

interface FlatExecutionNode {
	node: BonsaiExecutionTreeNode;
	depth: number;
	isLast: boolean;
	ancestorContinues: boolean[];
	parentId?: string;
}

function activeStatus(status: BonsaiTreeStatus): boolean {
	return status === "active" || status === "running";
}

function statusIcon(status: BonsaiTreeStatus): string {
	if (activeStatus(status)) return theme.fg("accent", "●");
	if (status === "waiting") return theme.fg("warning", "◐");
	if (status === "completed" || status === "closed") return theme.fg("success", "✓");
	if (status === "errored") return theme.fg("error", "●");
	if (status === "aborted" || status === "compacted") return theme.fg("muted", "○");
	return theme.fg("accent", "●");
}

class ExecutionTreeList implements Component {
	private readonly tui: TUI;
	private readonly maxVisible: number;
	private readonly onSelect: (node: BonsaiExecutionTreeNode) => void;
	private readonly onCancel: () => void;
	private readonly expanded = new Set<string>();
	private readonly shimmers = new Map<string, Shimmer>();
	private root: BonsaiExecutionTreeNode;
	private flat: FlatExecutionNode[] = [];
	private selectedIndex = 0;

	constructor(
		root: BonsaiExecutionTreeNode,
		tui: TUI,
		maxVisible: number,
		onSelect: (node: BonsaiExecutionTreeNode) => void,
		onCancel: () => void,
	) {
		this.root = root;
		this.tui = tui;
		this.maxVisible = Math.max(3, maxVisible);
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.expandAll(root);
		this.rebuild();
	}

	private expandAll(node: BonsaiExecutionTreeNode): void {
		if (node.children.length > 0) this.expanded.add(node.id);
		for (const child of node.children) this.expandAll(child);
	}

	private rebuild(): void {
		const selectedId = this.flat[this.selectedIndex]?.node.id;
		const flat: FlatExecutionNode[] = [];
		const visit = (
			node: BonsaiExecutionTreeNode,
			depth: number,
			isLast: boolean,
			ancestorContinues: boolean[],
			parentId?: string,
		): void => {
			flat.push({ node, depth, isLast, ancestorContinues, parentId });
			if (!this.expanded.has(node.id)) return;
			for (let index = 0; index < node.children.length; index++) {
				const child = node.children[index]!;
				visit(child, depth + 1, index === node.children.length - 1, [...ancestorContinues, !isLast], node.id);
			}
		};
		visit(this.root, 0, true, []);
		this.flat = flat;
		const nextIndex = selectedId ? flat.findIndex((row) => row.node.id === selectedId) : -1;
		this.selectedIndex = nextIndex >= 0 ? nextIndex : Math.min(this.selectedIndex, Math.max(0, flat.length - 1));
		this.syncShimmers();
	}

	private syncShimmers(): void {
		const currentIds = new Set(this.flat.map(({ node }) => node.id));
		for (const [id, shimmer] of this.shimmers) {
			if (currentIds.has(id)) continue;
			shimmer.dispose();
			this.shimmers.delete(id);
		}
		for (const { node } of this.flat) {
			let shimmer = this.shimmers.get(node.id);
			if (!shimmer) {
				shimmer = new Shimmer(this.tui, node.label, {
					dim: (text) => theme.fg(node.status === "waiting" ? "muted" : "toolTitle", text),
					base: (text) => theme.fg(node.status === "waiting" ? "warning" : "accent", text),
					bright: (text) => theme.fg(node.status === "waiting" ? "warning" : "success", theme.bold(text)),
				});
				this.shimmers.set(node.id, shimmer);
			}
			shimmer.setText(node.label);
			shimmer.setActive(
				activeStatus(node.status) || node.status === "waiting",
				node.status === "waiting" ? 140 : 70,
			);
		}
	}

	setRoot(root: BonsaiExecutionTreeNode): void {
		this.root = root;
		this.expandAll(root);
		this.rebuild();
	}

	getSelectedNode(): BonsaiExecutionTreeNode | undefined {
		return this.flat[this.selectedIndex]?.node;
	}

	private visibleStart(): number {
		return Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.flat.length - this.maxVisible),
		);
	}

	private selectAt(localY: number): boolean {
		const rowIndex = this.visibleStart() + localY;
		if (localY < 0 || rowIndex >= this.flat.length) return false;
		this.selectedIndex = rowIndex;
		const selected = this.getSelectedNode();
		if (selected) this.onSelect(selected);
		return true;
	}

	handleMouse(event: ComponentMouseEvent): boolean {
		return this.selectAt(event.localY);
	}

	invalidate(): void {
		for (const shimmer of this.shimmers.values()) shimmer.invalidate();
	}

	render(width: number): string[] {
		const start = this.visibleStart();
		const end = Math.min(this.flat.length, start + this.maxVisible);
		return this.flat.slice(start, end).map((row, visibleIndex) => {
			const selected = start + visibleIndex === this.selectedIndex;
			const ancestors =
				row.depth > 0
					? row.ancestorContinues
							.slice(1)
							.map((continues) => (continues ? "│  " : "   "))
							.join("")
					: "";
			const connector = row.depth === 0 ? "" : row.isLast ? "└─ " : "├─ ";
			const prefix = `${selected ? theme.fg("accent", "› ") : "  "}${ancestors}${connector}${statusIcon(row.node.status)} `;
			const maxLabelWidth = Math.max(1, width - visibleWidth(prefix));
			const label = truncateToWidth(row.node.label, maxLabelWidth, "...");
			const shimmer = this.shimmers.get(row.node.id);
			shimmer?.setText(label);
			const renderedLabel = shimmer?.render(Math.max(1, visibleWidth(label)))[0] ?? label;
			return `${prefix}${selected ? theme.bold(renderedLabel) : renderedLabel}`;
		});
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(this.flat.length - 1, this.selectedIndex + 1);
		} else if (kb.matches(data, "tui.editor.cursorLeft")) {
			const row = this.flat[this.selectedIndex];
			if (row && this.expanded.has(row.node.id) && row.node.children.length > 0) {
				this.expanded.delete(row.node.id);
				this.rebuild();
			} else if (row?.parentId) {
				const parentIndex = this.flat.findIndex(({ node }) => node.id === row.parentId);
				if (parentIndex >= 0) this.selectedIndex = parentIndex;
			}
		} else if (kb.matches(data, "tui.editor.cursorRight")) {
			const row = this.flat[this.selectedIndex];
			if (row?.node.children.length && !this.expanded.has(row.node.id)) {
				this.expanded.add(row.node.id);
				this.rebuild();
			}
		} else if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.getSelectedNode();
			if (selected) this.onSelect(selected);
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		}
		this.tui.requestRender();
	}

	dispose(): void {
		for (const shimmer of this.shimmers.values()) shimmer.dispose();
		this.shimmers.clear();
	}
}

export class ExecutionTreeSelectorComponent extends Container {
	private readonly list: ExecutionTreeList;

	constructor(
		root: BonsaiExecutionTreeNode,
		tui: TUI,
		maxVisible: number,
		onSelect: (node: BonsaiExecutionTreeNode) => void,
		onCancel: () => void,
	) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Bonsai Execution Tree"), 1, 0));
		this.addChild(new Text(theme.fg("muted", "Enter open · ←/→ fold · Esc close"), 1, 0));
		this.addChild(new DynamicBorder());
		this.list = new ExecutionTreeList(root, tui, maxVisible, onSelect, onCancel);
		this.addChild(this.list);
		this.addChild(new DynamicBorder());
	}

	setRoot(root: BonsaiExecutionTreeNode): void {
		this.list.setRoot(root);
	}

	getSelectedNode(): BonsaiExecutionTreeNode | undefined {
		return this.list.getSelectedNode();
	}

	override render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const lines = super.render(innerWidth);
		const border = theme.fg("border", "─".repeat(innerWidth));
		return [
			`${theme.fg("border", "┌")}${border}${theme.fg("border", "┐")}`,
			...lines.map(
				(line) =>
					`${theme.fg("border", "│")}${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))}${theme.fg("border", "│")}`,
			),
			`${theme.fg("border", "└")}${border}${theme.fg("border", "┘")}`,
		];
	}

	handleMouse(event: ComponentMouseEvent): boolean {
		return this.list.handleMouse({ ...event, localX: event.localX - 1, localY: event.localY - 5 });
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	dispose(): void {
		this.list.dispose();
	}
}
