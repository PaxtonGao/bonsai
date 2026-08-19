import { Container, getKeybindings, Text } from "@earendil-works/pi-tui";
import type { SessionEntry } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const value = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
			if (value.type === "text" && typeof value.text === "string") return value.text;
			if (value.type === "toolCall") return `[tool] ${String(value.name ?? "unknown")}`;
			if (value.type === "thinking" && typeof value.text === "string") return `[thinking] ${value.text}`;
			if (value.type === "toolResult") return `[tool result] ${String(value.text ?? "")}`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function transcriptText(entries: SessionEntry[]): string {
	const lines: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown; content?: unknown };
		const body = contentText(message.content);
		if (body) lines.push(`${String(message.role ?? "message")}:\n${body}`);
	}
	return lines.join("\n\n") || "No transcript content available.";
}

export class ChildTranscriptComponent extends Container {
	private readonly onClose: () => void;

	constructor(source: string, entries: SessionEntry[], onClose: () => void, title = "Bonsai Child Transcript") {
		super();
		this.onClose = onClose;
		this.addChild(new Text(theme.bold(title), 1, 0));
		this.addChild(new Text(theme.fg("muted", source), 1, 0));
		this.addChild(new DynamicBorder());
		this.addChild(new Text(transcriptText(entries), 1, 0));
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("muted", "Esc close"), 1, 0));
	}

	handleInput(data: string): void {
		if (getKeybindings().matches(data, "tui.select.cancel")) this.onClose();
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate();
	}
}
