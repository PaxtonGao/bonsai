import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, AgentSessionEventListener } from "../agent-session.ts";
import { assertValidSessionId, SessionManager } from "../session-manager.ts";
import type { NodeId } from "./model.ts";

type ParentSession = Pick<SessionManager, "getSessionDir" | "getSessionFile" | "getSessionId" | "isPersisted">;
type ChildSession = Pick<AgentSession, "sessionFile" | "sessionId" | "subscribe">;

export type BonsaiExecutionKind = "delegate" | "spine_spawn";
export type BonsaiExecutionStatus = "waiting" | "running" | "completed" | "errored" | "aborted";

export interface BonsaiExecutionSnapshot {
	executionRef: string;
	operationId: string;
	kind: BonsaiExecutionKind;
	label: string;
	nodeId: NodeId;
	status: BonsaiExecutionStatus;
	startedAt: number;
	finishedAt?: number;
	sessionFile?: string;
	profile?: string;
	ordinal?: number;
	toolCalls: number;
}

export interface BonsaiExecutionRegistration {
	operationId: string;
	kind: BonsaiExecutionKind;
	label: string;
	nodeId: NodeId;
	profile?: string;
	ordinal?: number;
}

export interface BonsaiExecutionHandle {
	finish(status: Extract<BonsaiExecutionStatus, "completed" | "errored" | "aborted">): void;
}

interface ExecutionRecord extends BonsaiExecutionSnapshot {
	child?: ChildSession;
	unsubscribeChild?: () => void;
}

interface ExecutionStore {
	records: Map<string, ExecutionRecord>;
	listeners: Set<() => void>;
}

const executionStores = new WeakMap<object, ExecutionStore>();

function storeFor(owner: object): ExecutionStore {
	let store = executionStores.get(owner);
	if (!store) {
		store = { records: new Map(), listeners: new Set() };
		executionStores.set(owner, store);
	}
	return store;
}

function notify(store: ExecutionStore): void {
	for (const listener of store.listeners) {
		try {
			listener();
		} catch {
			// UI observers must not interrupt child execution.
		}
	}
}

export function getBonsaiChildSessionDir(parent: ParentSession): string {
	return join(parent.getSessionDir(), "agents", parent.getSessionId());
}

export function createBonsaiChildSessionManager(parent: ParentSession, cwd: string): SessionManager {
	const parentSession = parent.getSessionFile();
	const options = parentSession ? { parentSession } : undefined;
	return parent.isPersisted()
		? SessionManager.create(cwd, getBonsaiChildSessionDir(parent), options)
		: SessionManager.inMemory(cwd, options);
}

export function findBonsaiChildSessionFile(parent: ParentSession, executionRef: string): string | undefined {
	assertValidSessionId(executionRef);
	if (!parent.isPersisted()) return undefined;
	const dir = getBonsaiChildSessionDir(parent);
	if (!existsSync(dir)) return undefined;
	const suffix = `_${executionRef}.jsonl`;
	return readdirSync(dir)
		.filter((name) => name.endsWith(suffix))
		.sort()
		.map((name) => join(dir, name))
		.at(-1);
}

export function openBonsaiChildTranscript(parent: ParentSession, executionRef: string): SessionManager | undefined {
	const path = findBonsaiChildSessionFile(parent, executionRef);
	return path ? SessionManager.open(path) : undefined;
}

export function registerBonsaiExecution(
	owner: object,
	child: ChildSession,
	registration: BonsaiExecutionRegistration,
): BonsaiExecutionHandle {
	const store = storeFor(owner);
	if (store.records.has(child.sessionId)) throw new Error(`Duplicate Bonsai execution: ${child.sessionId}`);
	const record: ExecutionRecord = {
		...registration,
		nodeId: registration.nodeId.slice(),
		executionRef: child.sessionId,
		status: "waiting",
		startedAt: Date.now(),
		sessionFile: child.sessionFile,
		toolCalls: 0,
		child,
	};
	const onChildEvent: AgentSessionEventListener = (event) => {
		if (record.status === "waiting" && event.type === "agent_start") record.status = "running";
		if (event.type === "tool_execution_start") record.toolCalls++;
		notify(store);
	};
	record.unsubscribeChild = child.subscribe(onChildEvent);
	store.records.set(record.executionRef, record);
	notify(store);

	let finished = false;
	return {
		finish(status) {
			if (finished) return;
			finished = true;
			record.status = status;
			record.finishedAt = Date.now();
			record.sessionFile = child.sessionFile;
			record.unsubscribeChild?.();
			delete record.unsubscribeChild;
			delete record.child;
			notify(store);
		},
	};
}

export function getBonsaiExecutions(owner: object): BonsaiExecutionSnapshot[] {
	const records = executionStores.get(owner)?.records.values() ?? [];
	return Array.from(records, ({ child: _child, unsubscribeChild: _unsubscribe, ...record }) => ({
		...record,
		nodeId: record.nodeId.slice(),
	})).sort((a, b) => a.startedAt - b.startedAt);
}

export function getRunningBonsaiExecution(owner: object, executionRef: string): ChildSession | undefined {
	return executionStores.get(owner)?.records.get(executionRef)?.child;
}

export function subscribeBonsaiExecutions(owner: object, listener: () => void): () => void {
	const store = storeFor(owner);
	store.listeners.add(listener);
	return () => store.listeners.delete(listener);
}
