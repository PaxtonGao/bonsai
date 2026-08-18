import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "../session-manager.ts";
import { createDelegateTool, type DelegateRuntime } from "./delegate.ts";
import { projectSpine } from "./projection.ts";
import { reduceSpine } from "./reducer.ts";
import { createSpineSpawnTool, type SpawnRuntime } from "./spawn.ts";
import { createSpineJitTools } from "./tools.ts";

function assertCompleteToolPairing(messages: AgentMessage[]): void {
	let pending = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			if (pending.size > 0) throw new Error("Bonsai projection produced an incomplete tool group");
			pending = new Map();
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				if (pending.has(part.id)) throw new Error("Bonsai projection produced duplicate tool call IDs");
				pending.set(part.id, part.name);
			}
			continue;
		}
		if (message.role === "toolResult") {
			if (pending.get(message.toolCallId) !== message.toolName) {
				throw new Error("Bonsai projection produced an orphan or mismatched tool result");
			}
			pending.delete(message.toolCallId);
			continue;
		}
		if (pending.size > 0) throw new Error("Bonsai projection split an assistant/tool-result group");
	}
	if (pending.size > 0) throw new Error("Bonsai projection produced an incomplete tool group");
}

export function createBonsaiIntegration(
	sessionManager: SessionManager,
	getSpawnRuntime?: () => SpawnRuntime | undefined,
	getDelegateRuntime?: () => DelegateRuntime | undefined,
) {
	let preResponseContext: AgentMessage[] = [];
	return {
		tools: [
			...createSpineJitTools(),
			...(getSpawnRuntime ? [createSpineSpawnTool(getSpawnRuntime)] : []),
			...(getDelegateRuntime ? [createDelegateTool(getDelegateRuntime)] : []),
		],
		project(messages: AgentMessage[]) {
			const entries = sessionManager.getBranch();
			return projectSpine(entries, reduceSpine(entries), messages);
		},
		capture(messages: AgentMessage[]) {
			assertCompleteToolPairing(messages);
			preResponseContext = messages.slice();
			return messages;
		},
		getPreResponseContext() {
			return preResponseContext.slice();
		},
	};
}
