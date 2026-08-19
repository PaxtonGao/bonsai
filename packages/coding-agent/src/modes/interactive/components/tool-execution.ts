import { basename, dirname } from "node:path";
import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	Shimmer,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput, shortenPath } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

const FALLBACK_PREVIEW_LINES = 10;
const IMAGE_EXTENSIONS = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;

function stringArg(args: unknown, ...keys: string[]): string {
	if (!args || typeof args !== "object" || Array.isArray(args)) return "";
	const values = args as Record<string, unknown>;
	for (const key of keys) {
		if (typeof values[key] === "string" && values[key].trim()) return values[key].trim();
	}
	return "";
}

function compact(text: string, maxLength = 72): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function readRange(args: unknown): string {
	if (!args || typeof args !== "object" || Array.isArray(args)) return "";
	const values = args as Record<string, unknown>;
	const offset = typeof values.offset === "number" ? values.offset : undefined;
	const limit = typeof values.limit === "number" ? values.limit : undefined;
	if (offset === undefined && limit === undefined) return "";
	const start = offset ?? 1;
	return `:${start}${limit === undefined ? "" : `-${start + limit - 1}`}`;
}

function summarizeBash(command: string): string {
	const restart = command.match(/(?:^|[;&|]\s*)([~./][^\s;&|]+)\s+restart\b/i);
	if (restart?.[1] && /\bstatus\b/i.test(command)) {
		return `🤖 重启并检查：${basename(restart[1])}`;
	}
	if (/\b(?:curl|wget)\b/i.test(command)) {
		const url = command.match(/https?:\/\/[^\s"'|;)]+/)?.[0];
		if (url) {
			try {
				const parsed = new URL(url);
				return `🌐 下载或请求：${compact(`${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`)}`;
			} catch {
				return `🌐 下载或请求：${compact(url)}`;
			}
		}
	}
	if (/\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b/i.test(command)) return "📦 安装依赖";
	if (/\b(?:vitest|pytest|cargo\s+test|go\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test)\b/i.test(command))
		return "🧪 运行测试";
	if (/\b(?:rg|grep)\b/i.test(command)) return `🔍 搜索文本：${compact(command)}`;
	if (/\b(?:cat|head|tail|sed\s+-n)\b/i.test(command)) return `📖 查看文件或输出：${compact(command)}`;
	const git = command.match(/\bgit\s+([a-z-]+)/i);
	if (git?.[1]) return `🔀 执行 Git 操作：${git[1]}`;
	return `🤖 运行命令：${compact(command)}`;
}

function summarizeTool(toolName: string, label: string, args: unknown): string | undefined {
	const name = toolName.toLowerCase();
	const path = stringArg(args, "path", "file_path", "image_path");
	if (name === "bash") return summarizeBash(stringArg(args, "command"));
	if (name === "read") {
		if (path && IMAGE_EXTENSIONS.test(path)) return `🧐 查看图片：${shortenPath(path)}`;
		const range = readRange(args);
		if (basename(path) === "SKILL.md") return `🧩 加载技能：${basename(dirname(path))}${range}`;
		if (/^(?:AGENTS(?:\.override)?|CLAUDE)\.md$/i.test(basename(path)))
			return `📖 读取项目指令：${shortenPath(path)}${range}`;
		if (basename(path).toLowerCase() === "readme.md") return `📚 读取文档：${shortenPath(path)}${range}`;
		return `📖 读取文件：${shortenPath(path) || "..."}${range}`;
	}
	if (name === "write") return `✏️ 写入文件：${shortenPath(path) || "..."}`;
	if (name === "edit") return `✏️ 编辑文件：${shortenPath(path) || "..."}`;
	if (name === "grep") {
		const pattern = stringArg(args, "pattern");
		return `🔍 搜索代码：${compact(pattern || "...")}${path ? ` · ${shortenPath(path)}` : ""}`;
	}
	if (name === "find") {
		return `🔍 查找文件：${compact(stringArg(args, "pattern") || "...")}${path ? ` · ${shortenPath(path)}` : ""}`;
	}
	if (name === "ls") return `📂 查看目录：${shortenPath(path) || "."}`;
	if (name.includes("image") || name.includes("screenshot"))
		return `🧐 查看图片：${shortenPath(path) || compact(stringArg(args, "url")) || label}`;
	const query = stringArg(args, "query", "q", "search_query");
	if (query && (name.includes("search") || name.includes("tavily"))) return `🔍 网络搜索：${compact(query)}`;
	if (name === "spine_open") return `🌱 创建任务节点：${compact(stringArg(args, "goal") || "...")}`;
	if (name === "spine_close") return "🌿 关闭任务节点";
	if (name === "spine_next") return `🌱 切换任务节点：${compact(stringArg(args, "goal") || "...")}`;
	if (name === "spine_trim") return "✂️ 裁剪工具结果";
	if (name === "spine_spawn") {
		const tasks =
			args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>).tasks : null;
		return `🌳 并行执行 ${Array.isArray(tasks) ? tasks.length : "多个"} 个任务分支`;
	}
	if (name.includes("ask") && name.includes("user")) return "❓ 请求用户选择";
	return undefined;
}

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private summaryBox: Box;
	private summaryText: Shimmer;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.summaryBox = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text));
		this.summaryText = new Shimmer(this.ui, "", {
			dim: (text) => theme.fg("muted", theme.bold(text)),
			base: (text) => theme.fg("toolTitle", theme.bold(text)),
			bright: (text) => chalk.hex("#b0f04a")(theme.bold(text)),
			// Bonsai-green wave gradient; hardcoded hex until theme tokens are needed.
			trail: [
				(text) => chalk.hex("#58d68d")(text),
				(text) => chalk.hex("#7ee06b")(text),
				(text) => chalk.hex("#a5e04e")(text),
				(text) => chalk.hex("#3ecf8e")(text),
				(text) => chalk.hex("#a8d8b0")(text),
			],
			intervalMs: 110,
		});
		this.summaryText.setActive(true);
		this.summaryBox.addChild(this.summaryText);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}

		const lines = output.split("\n");
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return new Text(text, 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.summaryText.setActive(isPartial);
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	dispose(): void {
		this.summaryText.dispose();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		if (!this.expanded) {
			const label = this.toolDefinition?.label ?? this.builtInToolDefinition?.label ?? this.toolName;
			let summary = summarizeTool(this.toolName, label, this.args);
			if (summary) {
				const bgFn = this.isPartial
					? (text: string) => theme.bg("toolPendingBg", text)
					: this.result?.isError
						? (text: string) => theme.bg("toolErrorBg", text)
						: (text: string) => theme.bg("toolSuccessBg", text);
				if (this.result?.isError) {
					const error = compact(this.getTextOutput().split("\n")[0] ?? "", 48);
					summary = `❌ ${summary}${error ? ` — ${error}` : ""}`;
				}
				this.summaryBox.setBgFn(bgFn);
				this.summaryText.setText(truncateToWidth(summary, Math.max(1, width - 2), "..."));
				return ["", ...this.summaryBox.render(width)];
			}
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				return [];
			}

			const lines: string[] = [];
			if (contentLines.length > 0) {
				lines.push("");
				lines.push(...contentLines);
			}
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					lines.push(...spacer.render(width));
				}
				const imageComponent = this.imageComponents[i];
				if (imageComponent) {
					lines.push(...imageComponent.render(width));
				}
			}
			return lines;
		}

		return super.render(width);
	}

	private updateDisplay(): void {
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
