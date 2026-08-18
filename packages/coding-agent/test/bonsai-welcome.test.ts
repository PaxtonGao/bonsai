import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { BonsaiWelcomeComponent } from "../src/modes/interactive/components/bonsai-welcome.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("BonsaiWelcomeComponent", () => {
	beforeAll(() => initTheme("dark"));

	function createWelcome(): BonsaiWelcomeComponent {
		return new BonsaiWelcomeComponent({
			version: "0.84.2",
			skills: ["research", "code-review"],
			extensions: ["ask-user-question", "otty-integration"],
			getCompactHints: () => "/ commands · @ files · ! bash · ctrl+o more",
			getExpandedHints: () => "escape interrupt · ctrl+c clear · ctrl+d exit · ctrl+o less",
			getExpandKey: () => "ctrl+o",
		});
	}

	test("keeps every wide border and divider on the same columns", () => {
		const width = 100;
		const lines = createWelcome().render(width);
		const plain = lines.map(stripTerminalSequences);

		expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
		const dividerColumns = plain
			.slice(1, -3)
			.map((line) => Math.max(line.indexOf("│", 1), line.indexOf("├", 1)))
			.filter((column) => column > 0);
		expect(new Set(dividerColumns)).toEqual(new Set([35]));
		expect(plain.join("\n")).toContain("█▄  █▀█ █▄░█ █▀ █▀█ █");
		expect(plain.join("\n")).toContain("Skills");
		expect(plain.join("\n")).toContain("Extensions");
	});

	test("expands resource names in place", () => {
		const welcome = createWelcome();
		welcome.setExpanded(true);
		const output = welcome.render(100).map(stripTerminalSequences).join("\n");

		expect(output).toContain("code-review · research");
		expect(output).toContain("ask-user-question · otty-integration");
		expect(output).toContain("ctrl+o to collapse");
	});

	test("uses stacked sections on narrow terminals", () => {
		const width = 60;
		const lines = createWelcome().render(width);
		const output = lines.map(stripTerminalSequences).join("\n");

		expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
		expect(output).toContain("Bonsai v0.84.2");
		expect(output).toContain("Skills");
		expect(output).toContain("Extensions");
	});
});
