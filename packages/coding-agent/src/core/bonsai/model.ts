import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type NodeId = number[];
export type NodeKind = "root" | "task";
export type NodeStatus = "live" | "opened" | "closed" | "compacted";
export type SpawnOutcome = "completed" | "errored" | "aborted";

export interface SpawnTask {
	summary: string;
	prompt: string;
}

export interface SpawnResult {
	ordinal: number;
	outcome: SpawnOutcome;
	memory_body: string;
	diagnostic?: string;
	execution_ref?: string;
}

export interface SpawnReceipt {
	schema: "spine.spawn.result.v1";
	results: SpawnResult[];
}

export type MemorySlot =
	| { kind: "user"; ownerNode: NodeId; message: AgentMessage; anchor: number }
	| { kind: "summary"; ownerNode: NodeId; body: string }
	| {
			kind: "spawn-evidence";
			ownerNode: NodeId;
			task: SpawnTask;
			outcome: SpawnOutcome;
			diagnostic?: string;
			executionRef?: string;
	  };

export type ProjectionItem =
	| {
			kind: "raw";
			messages: AgentMessage[];
			boundaries: Array<number | undefined>;
			userAnchors: Array<number | undefined>;
	  }
	| { kind: "node"; nodeId: NodeId; goal: string }
	| { kind: "memory"; slot: MemorySlot };

export interface SpineNode {
	id: NodeId;
	parent?: NodeId;
	children: NodeId[];
	kind: NodeKind;
	status: NodeStatus;
	goal: string;
	memory?: MemorySlot[];
	start: number;
	end?: number;
}

export interface SpineSnapshot {
	nodes: SpineNode[];
	cursor: NodeId;
	epoch: number;
	visibleContext: ProjectionItem[];
	trimEdits: TrimEdit[];
}

export type TrimOperation =
	| { op: "snip" }
	| { op: "slice"; head: number }
	| { op: "slice"; tail: number }
	| { op: "slice"; anchor: string; preceding: number; following: number };

export interface TrimRequest {
	TRIM_ID: string;
	operation: TrimOperation;
}

export type TrimEdit =
	| { boundary: number; callId: string; kind: "tagged"; trimId: string; body: string }
	| { boundary: number; callId: string; kind: "snipped" }
	| { boundary: number; callId: string; kind: "sliced"; body: string };

export interface SpineToolCall {
	callId: string;
	name: string;
	arguments: unknown;
	ordinal: number;
	outcome: "succeeded" | "failed" | "unknown";
	output?: string;
	outputBoundary?: number;
}

export interface SpineToolGroup {
	start: number;
	end: number;
	messages: AgentMessage[];
	calls: SpineToolCall[];
}

export type SpineEvent =
	| { kind: "message"; boundary: number; message: AgentMessage }
	| { kind: "tool-group"; group: SpineToolGroup }
	| { kind: "compact"; boundary: number; replacementHistory: AgentMessage[] };

export const SPAWN_RECEIPT_SCHEMA = "spine.spawn.result.v1";
export const TRIM_THRESHOLD_BYTES = 10_000;

export function nodeIdText(id: NodeId): string {
	return id.join(".");
}
