import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../session-manager.ts";
import { type MemorySlot, nodeIdText, type SpineSnapshot } from "./model.ts";

function applyTrim(message: AgentMessage, boundary: number | undefined, snapshot: SpineSnapshot): AgentMessage {
	if (message.role !== "toolResult" || boundary === undefined) return message;
	if (message.toolName === "spine.spawn" && !message.isError) {
		return { ...message, content: [{ type: "text", text: '{"status":"success"}' }] };
	}
	const edit = snapshot.trimEdits.find(
		(candidate) => candidate.boundary === boundary && candidate.callId === message.toolCallId,
	);
	if (!edit) return message;
	const body =
		edit.kind === "tagged"
			? `[TRIM_ID: ${edit.trimId}]\n${edit.body}`
			: edit.kind === "snipped"
				? "[Old tool result content cleared]"
				: edit.body;
	return { ...message, content: [{ type: "text", text: body }] };
}

function contextualMessage(customType: string, content: string): AgentMessage {
	return {
		role: "custom",
		customType,
		content,
		display: false,
		timestamp: Date.now(),
	};
}

function anchoredUser(message: AgentMessage, anchor: number): AgentMessage {
	if (message.role !== "user") return message;
	const prefix = `[U${anchor}]\n`;
	if (typeof message.content === "string") {
		return { ...message, content: prefix + message.content };
	}
	const content: Array<TextContent | ImageContent> = message.content.map((part) => ({ ...part }));
	const textIndex = content.findIndex((part) => part.type === "text");
	if (textIndex === -1) {
		content.unshift({ type: "text", text: prefix });
	} else {
		const text = content[textIndex];
		if (text?.type === "text") content[textIndex] = { ...text, text: prefix + text.text };
	}
	return { ...message, content } satisfies UserMessage;
}

function renderMemory(slot: MemorySlot): AgentMessage {
	if (slot.kind === "user") return anchoredUser(slot.message, slot.anchor);
	const id = nodeIdText(slot.ownerNode);
	if (slot.kind === "summary") {
		return contextualMessage("bonsai.spine-memory", `<spine_memory node_id="${id}">\n${slot.body}\n</spine_memory>`);
	}
	return contextualMessage(
		"bonsai.spine-spawn-evidence",
		`<spine_spawn_evidence node_id="${id}">\n${JSON.stringify(
			{
				summary: slot.task.summary,
				prompt: slot.task.prompt,
				outcome: slot.outcome,
				diagnostic: slot.diagnostic ?? null,
				execution_ref: slot.executionRef ?? null,
			},
			null,
			2,
		)}\n</spine_spawn_evidence>`,
	);
}

export function projectSpine(
	_entries: SessionEntry[],
	snapshot: SpineSnapshot,
	currentMessages: AgentMessage[],
): AgentMessage[] {
	const available = new Map<string, number>();
	for (const message of currentMessages) {
		const key = JSON.stringify(message);
		available.set(key, (available.get(key) ?? 0) + 1);
	}
	const output: AgentMessage[] = [];
	for (const item of snapshot.visibleContext) {
		if (item.kind === "node") {
			output.push(
				contextualMessage(
					"bonsai.spine-node",
					`<spine_node id="${nodeIdText(item.nodeId)}" summary="${item.goal.replaceAll('"', "&quot;")}" status="opened" />`,
				),
			);
			continue;
		}
		if (item.kind === "memory") {
			output.push(renderMemory(item.slot));
			continue;
		}
		item.messages.forEach((message, index) => {
			const key = JSON.stringify(message);
			const remaining = available.get(key) ?? 0;
			if (remaining === 0) return;
			available.set(key, remaining - 1);
			const anchor = item.userAnchors[index];
			const trimmed = applyTrim(message, item.boundaries[index], snapshot);
			output.push(anchor === undefined ? trimmed : anchoredUser(trimmed, anchor));
		});
	}
	return output;
}
