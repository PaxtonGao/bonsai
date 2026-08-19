import { stripVTControlCharacters } from "node:util";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BonsaiExecutionTreeNode } from "../src/core/bonsai/execution-tree.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExecutionTreeSelectorComponent } from "../src/modes/interactive/components/execution-tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

function tree(): BonsaiExecutionTreeNode {
	return {
		id: "root",
		kind: "root",
		label: "Main Session",
		status: "active",
		order: 0,
		children: [
			{
				id: "spine:1.1",
				kind: "spine",
				label: "inspect parser",
				status: "live",
				order: 1,
				nodeId: [1, 1],
				children: [
					{
						id: "execution:child",
						kind: "execution",
						label: "explorer: map parser",
						status: "running",
						order: 2,
						executionRef: "child",
						children: [],
					},
				],
			},
		],
	};
}

describe("ExecutionTreeSelectorComponent", () => {
	it("renders Unicode hierarchy and activates the selected row", () => {
		const selected = vi.fn();
		const component = new ExecutionTreeSelectorComponent(
			tree(),
			{ requestRender: vi.fn() } as unknown as TUI,
			8,
			selected,
			vi.fn(),
		);
		const rendered = stripVTControlCharacters(component.render(80).join("\n"));
		expect(rendered).toContain("Main Session");
		expect(rendered).toContain("└─ ● inspect parser");
		expect(rendered).toContain("└─ ● explorer: map parser");

		component.handleInput("\x1b[B");
		component.handleInput("\r");
		expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "spine:1.1" }));
		component.dispose();
	});

	it("collapses and expands branches with left and right", () => {
		const component = new ExecutionTreeSelectorComponent(
			tree(),
			{ requestRender: vi.fn() } as unknown as TUI,
			8,
			vi.fn(),
			vi.fn(),
		);
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[D");
		expect(stripVTControlCharacters(component.render(80).join("\n"))).not.toContain("map parser");
		component.handleInput("\x1b[C");
		expect(stripVTControlCharacters(component.render(80).join("\n"))).toContain("map parser");
		component.dispose();
	});

	it("treats a mouse click on a row like Enter", () => {
		const selected = vi.fn();
		const component = new ExecutionTreeSelectorComponent(
			tree(),
			{ requestRender: vi.fn() } as unknown as TUI,
			8,
			selected,
			vi.fn(),
		);

		expect(component.handleMouse({ x: 2, y: 6, localX: 2, localY: 6, width: 80, button: 0 })).toBe(true);
		expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "spine:1.1" }));
		component.dispose();
	});
});
