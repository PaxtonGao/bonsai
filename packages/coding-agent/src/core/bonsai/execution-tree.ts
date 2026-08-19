import type { SessionEntry } from "../session-manager.ts";
import type { BonsaiExecutionSnapshot, BonsaiExecutionStatus } from "./executions.ts";
import type { DelegateReceipt, NodeId, SpineNode } from "./model.ts";
import { lexSpineEntries, reduceSpine } from "./reducer.ts";

export type BonsaiTreeStatus = BonsaiExecutionStatus | "active" | "live" | "opened" | "closed" | "compacted";

export interface BonsaiExecutionTreeNode {
	id: string;
	kind: "root" | "spine" | "operation" | "execution";
	label: string;
	status: BonsaiTreeStatus;
	children: BonsaiExecutionTreeNode[];
	order: number;
	nodeId?: NodeId;
	operationId?: string;
	executionRef?: string;
	sessionFile?: string;
}

function idText(id: NodeId): string {
	return id.join(".");
}

function ownerAt(nodes: SpineNode[], boundary: number): NodeId {
	return (
		nodes
			.filter((node) => node.start <= boundary && (node.end === undefined || boundary <= node.end))
			.sort((left, right) => right.id.length - left.id.length)[0]?.id ?? [1]
	);
}

function parseDelegate(output: string | undefined): DelegateReceipt | undefined {
	if (!output) return undefined;
	try {
		const value = JSON.parse(output) as Partial<DelegateReceipt>;
		if (
			value.schema !== "bonsai.delegate.result.v1" ||
			typeof value.profile !== "string" ||
			typeof value.execution_ref !== "string" ||
			!value.execution_ref ||
			(value.outcome !== "completed" && value.outcome !== "errored" && value.outcome !== "aborted")
		) {
			return undefined;
		}
		return value as DelegateReceipt;
	} catch {
		return undefined;
	}
}

function executionNode(execution: BonsaiExecutionSnapshot, order: number): BonsaiExecutionTreeNode {
	return {
		id: `execution:${execution.executionRef}`,
		kind: "execution",
		label: `${execution.profile ? `${execution.profile}: ` : ""}${execution.label}`,
		status: execution.status,
		children: [],
		order,
		nodeId: execution.nodeId.slice(),
		operationId: execution.operationId,
		executionRef: execution.executionRef,
		sessionFile: execution.sessionFile,
	};
}

export function projectBonsaiExecutionTree(
	entries: SessionEntry[],
	runtimeExecutions: BonsaiExecutionSnapshot[] = [],
): BonsaiExecutionTreeNode {
	const snapshot = reduceSpine(entries);
	const byId = new Map(snapshot.nodes.map((node) => [idText(node.id), node]));
	const rootNodeId = [snapshot.epoch];
	const persistedByOwner = new Map<string, BonsaiExecutionTreeNode[]>();
	const spawnOperationByBoundary = new Map<number, string>();
	const seenExecutions = new Set<string>();

	for (const event of lexSpineEntries(entries)) {
		if (event.kind !== "tool-group") continue;
		const spawn = event.group.calls.find((call) => call.name === "spine_spawn" && call.outcome === "succeeded");
		if (spawn) spawnOperationByBoundary.set(event.group.start, spawn.callId);
		const delegate = event.group.calls.find((call) => call.name === "delegate" && call.outcome === "succeeded");
		if (!delegate) continue;
		const receipt = parseDelegate(delegate.output);
		if (!receipt) continue;
		const args = delegate.arguments as { profile?: unknown; task?: unknown };
		const owner = ownerAt(snapshot.nodes, event.group.start);
		const node: BonsaiExecutionTreeNode = {
			id: `execution:${receipt.execution_ref}`,
			kind: "execution",
			label: `${receipt.profile}: ${typeof args.task === "string" ? args.task : "delegate"}`,
			status: receipt.outcome,
			children: [],
			order: event.group.start,
			nodeId: owner.slice(),
			operationId: delegate.callId,
			executionRef: receipt.execution_ref,
		};
		const key = idText(owner);
		persistedByOwner.set(key, [...(persistedByOwner.get(key) ?? []), node]);
		seenExecutions.add(receipt.execution_ref);
	}

	const runtimeByOwner = new Map<string, BonsaiExecutionSnapshot[]>();
	for (const execution of runtimeExecutions) {
		if (seenExecutions.has(execution.executionRef)) continue;
		const key = idText(execution.nodeId);
		runtimeByOwner.set(key, [...(runtimeByOwner.get(key) ?? []), execution]);
	}

	const buildChildren = (ownerId: NodeId): BonsaiExecutionTreeNode[] => {
		const owner = byId.get(idText(ownerId));
		if (!owner) return [];
		const children = [...(persistedByOwner.get(idText(ownerId)) ?? [])];
		const spawnGroups = new Map<number, SpineNode[]>();
		for (const childId of owner.children) {
			const child = byId.get(idText(childId));
			if (!child) continue;
			const evidence = child.memory?.find((slot) => slot.kind === "spawn-evidence");
			if (evidence) {
				spawnGroups.set(child.start, [...(spawnGroups.get(child.start) ?? []), child]);
				continue;
			}
			children.push({
				id: `spine:${idText(child.id)}`,
				kind: "spine",
				label: child.goal,
				status: child.status,
				children: buildChildren(child.id),
				order: child.start,
				nodeId: child.id.slice(),
			});
		}
		for (const [boundary, spawnChildren] of spawnGroups) {
			const operationId = spawnOperationByBoundary.get(boundary) ?? `spawn:${boundary}`;
			const executionChildren = spawnChildren.map((child, ordinal): BonsaiExecutionTreeNode => {
				const evidence = child.memory?.find((slot) => slot.kind === "spawn-evidence");
				const executionRef = evidence?.kind === "spawn-evidence" ? evidence.executionRef : undefined;
				if (executionRef) seenExecutions.add(executionRef);
				return {
					id: executionRef ? `execution:${executionRef}` : `spine:${idText(child.id)}`,
					kind: "execution",
					label: child.goal,
					status: evidence?.kind === "spawn-evidence" ? evidence.outcome : "closed",
					children: [],
					order: ordinal,
					nodeId: child.id.slice(),
					operationId,
					...(executionRef ? { executionRef } : {}),
				};
			});
			children.push({
				id: `operation:${operationId}`,
				kind: "operation",
				label: "spine_spawn",
				status: "completed",
				children: executionChildren,
				order: boundary,
				nodeId: ownerId.slice(),
				operationId,
			});
		}

		const runtime = runtimeByOwner.get(idText(ownerId)) ?? [];
		const spawnRuntime = new Map<string, BonsaiExecutionSnapshot[]>();
		for (const execution of runtime) {
			if (execution.kind === "delegate") {
				children.push(executionNode(execution, Number.MAX_SAFE_INTEGER + execution.startedAt));
			} else {
				spawnRuntime.set(execution.operationId, [...(spawnRuntime.get(execution.operationId) ?? []), execution]);
			}
		}
		for (const [operationId, executions] of spawnRuntime) {
			children.push({
				id: `operation:${operationId}`,
				kind: "operation",
				label: "spine_spawn",
				status: executions.some((execution) => execution.status === "running") ? "active" : "waiting",
				children: executions.map((execution) => executionNode(execution, execution.ordinal ?? 0)),
				order: Number.MAX_SAFE_INTEGER + Math.min(...executions.map((execution) => execution.startedAt)),
				nodeId: ownerId.slice(),
				operationId,
			});
		}
		return children.sort((left, right) => left.order - right.order);
	};

	return {
		id: "root",
		kind: "root",
		label: "Main Session",
		status: "active",
		children: buildChildren(rootNodeId),
		order: 0,
		nodeId: rootNodeId,
	};
}
