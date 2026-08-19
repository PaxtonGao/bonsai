import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	type ComponentMouseEvent,
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private readonly expandedThinkingRuns = new Set<number>();
	private readonly thinkingComponents = new Map<Component, number>();
	private thinkingRows: Array<{ start: number; end: number; runStart: number }> = [];

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		let row = 0;
		this.thinkingRows = [];
		for (const child of this.contentContainer.children) {
			const height = child.render(width).length;
			const runStart = this.thinkingComponents.get(child);
			if (runStart !== undefined) this.thinkingRows.push({ start: row, end: row + height, runStart });
			row += height;
		}
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	handleMouse(event: ComponentMouseEvent): boolean | undefined {
		if (this.hideThinkingBlock) return undefined;
		const row = this.thinkingRows.find(
			(candidate) => event.localY >= candidate.start && event.localY < candidate.end,
		);
		if (!row) return undefined;
		this.toggleThinkingRun(row.runStart);
		return true;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		const stoppedStreaming = this.isStreaming && !isStreaming;
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		if (stoppedStreaming) this.expandedThinkingRuns.clear();

		// Clear content container
		this.contentContainer.clear();
		this.thinkingComponents.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
			} else if (content.type === "thinking") {
				const runStart = i;
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				const expanded = this.isStreaming || this.expandedThinkingRuns.has(runStart);
				let thinkingComponent: Component;
				if (this.hideThinkingBlock) {
					// Show one static label for each run of thinking blocks when hidden.
					thinkingComponent = new Text(
						theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)),
						this.outputPad,
						0,
					);
				} else if (!expanded) {
					thinkingComponent = new Text(
						theme.italic(theme.fg("thinkingText", `▶ ${this.hiddenThinkingLabel}`)),
						this.outputPad,
						0,
					);
				} else {
					const thinkingWrapper = new Container();
					thinkingWrapper.addChild(
						new Text(theme.italic(theme.fg("thinkingText", "▼ Thinking")), this.outputPad, 0),
					);
					thinkingWrapper.addChild(
						new Markdown(
							thinkingBlocks.join("\n\n"),
							this.outputPad,
							0,
							this.markdownTheme,
							{
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
							},
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
							},
						),
					);
					thinkingComponent = thinkingWrapper;
				}
				this.thinkingComponents.set(thinkingComponent, runStart);
				this.contentContainer.addChild(thinkingComponent);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}

	toggleThinkingRun(runStart: number): void {
		if (!this.expandedThinkingRuns.delete(runStart)) this.expandedThinkingRuns.add(runStart);
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}
}
