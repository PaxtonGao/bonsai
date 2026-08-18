import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export interface BonsaiWelcomeOptions {
	version: string;
	skills: string[];
	extensions: string[];
	getCompactHints: () => string;
	getExpandedHints: () => string;
	getExpandKey: () => string;
	expanded?: boolean;
}

const WIDE_LAYOUT_MIN_WIDTH = 72;
const LOGO_LINES = ["█▄  █▀█ █▄░█ █▀ █▀█ █", "█▄▀ █▄█ █░▀█ ▄█ █▀█ █"];

function fitCell(text: string, width: number, align: "left" | "center" = "left"): string {
	const clipped = truncateToWidth(text, width);
	const padding = Math.max(0, width - visibleWidth(clipped));
	if (align === "center") {
		const left = Math.floor(padding / 2);
		return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
	}
	return `${clipped}${" ".repeat(padding)}`;
}

function centeredLines(lines: string[], height: number): string[] {
	const top = Math.max(0, Math.floor((height - lines.length) / 2));
	return [
		...Array.from({ length: top }, () => ""),
		...lines,
		...Array.from({ length: height - top - lines.length }, () => ""),
	];
}

function resourceLines(name: string, items: string[], width: number, expanded: boolean, expandKey: string): string[] {
	const count = String(items.length);
	const headingWidth = Math.max(1, width - count.length - 1);
	const heading = `${fitCell(theme.bold(theme.fg("mdHeading", name)), headingWidth)} ${theme.fg("muted", count)}`;
	if (!expanded) {
		const description =
			name === "Skills" ? "Project workflows and agent capabilities" : "Runtime integrations and custom tools";
		return [heading, "", theme.fg("dim", description), theme.fg("muted", `${expandKey} to expand`)];
	}

	const body =
		items.length > 0
			? items
					.slice()
					.sort((a, b) => a.localeCompare(b))
					.join(" · ")
			: "None loaded";
	return [
		heading,
		"",
		...wrapTextWithAnsi(theme.fg("dim", body), width),
		"",
		theme.fg("muted", `${expandKey} to collapse`),
	];
}

export class BonsaiWelcomeComponent implements Component {
	private readonly options: BonsaiWelcomeOptions;
	private skills: string[];
	private extensions: string[];
	private expanded: boolean;

	constructor(options: BonsaiWelcomeOptions) {
		this.options = options;
		this.skills = options.skills;
		this.extensions = options.extensions;
		this.expanded = options.expanded ?? false;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	setResources(skills: string[], extensions: string[]): void {
		this.skills = skills;
		this.extensions = extensions;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(10, width);
		return safeWidth >= WIDE_LAYOUT_MIN_WIDTH ? this.renderWide(safeWidth) : this.renderNarrow(safeWidth);
	}

	private border(text: string): string {
		return theme.fg("borderMuted", text);
	}

	private renderWide(width: number): string[] {
		const leftWidth = Math.min(34, Math.max(26, Math.floor((width - 3) * 0.38)));
		const rightWidth = width - leftWidth - 3;
		const expandKey = this.options.getExpandKey();
		const skills = resourceLines("Skills", this.skills, rightWidth - 4, this.expanded, expandKey);
		const extensions = resourceLines("Extensions", this.extensions, rightWidth - 4, this.expanded, expandKey);
		const topHeight = Math.max(4, skills.length);
		const bottomHeight = Math.max(4, extensions.length);
		const contentHeight = topHeight + bottomHeight + 1;
		const left = centeredLines(
			[
				...LOGO_LINES.map((line) => theme.bold(theme.fg("accent", line))),
				"",
				theme.fg("muted", `Bonsai v${this.options.version}`),
				"",
				theme.fg("dim", "Grow branches of context."),
			],
			contentHeight,
		);
		const lines = [this.border(`╭${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}╮`)];
		const row = (leftText: string, rightText: string): string =>
			`${this.border("│")}${fitCell(leftText, leftWidth, "center")}${this.border("│")}${fitCell(`  ${rightText}`, rightWidth)}${this.border("│")}`;

		for (let index = 0; index < topHeight; index += 1) {
			lines.push(row(left[index] ?? "", skills[index] ?? ""));
		}
		lines.push(
			`${this.border("│")}${fitCell(left[topHeight] ?? "", leftWidth, "center")}${this.border(`├${"─".repeat(rightWidth)}┤`)}`,
		);
		for (let index = 0; index < bottomHeight; index += 1) {
			lines.push(row(left[topHeight + index + 1] ?? "", extensions[index] ?? ""));
		}
		lines.push(this.border(`├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`));
		lines.push(...this.renderFooter(width));
		lines.push(this.border(`╰${"─".repeat(width - 2)}╯`));
		return lines;
	}

	private renderNarrow(width: number): string[] {
		const contentWidth = width - 4;
		const expandKey = this.options.getExpandKey();
		const sections = [
			resourceLines("Skills", this.skills, contentWidth, this.expanded, expandKey),
			resourceLines("Extensions", this.extensions, contentWidth, this.expanded, expandKey),
		];
		const lines = [this.border(`╭${"─".repeat(width - 2)}╮`)];
		for (const line of [
			"",
			...LOGO_LINES.map((logoLine) => theme.bold(theme.fg("accent", logoLine))),
			"",
			theme.fg("muted", `Bonsai v${this.options.version}`),
			"",
		]) {
			lines.push(`${this.border("│")}${fitCell(line, width - 2, "center")}${this.border("│")}`);
		}
		for (const section of sections) {
			lines.push(this.border(`├${"─".repeat(width - 2)}┤`));
			for (const line of section) {
				lines.push(`${this.border("│")}${fitCell(`  ${line}`, width - 2)}${this.border("│")}`);
			}
		}
		lines.push(this.border(`├${"─".repeat(width - 2)}┤`));
		lines.push(...this.renderFooter(width));
		lines.push(this.border(`╰${"─".repeat(width - 2)}╯`));
		return lines;
	}

	private renderFooter(width: number): string[] {
		const footer = this.expanded ? this.options.getExpandedHints() : this.options.getCompactHints();
		return wrapTextWithAnsi(footer, width - 4).map(
			(line) => `${this.border("│")}${fitCell(` ${line}`, width - 2)}${this.border("│")}`,
		);
	}
}
