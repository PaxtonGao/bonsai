import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEventListener } from "../src/core/agent-session.ts";
import {
	createBonsaiChildSessionManager,
	findBonsaiChildSessionFile,
	getBonsaiExecutions,
	getRunningBonsaiExecution,
	openBonsaiChildTranscript,
	registerBonsaiExecution,
	subscribeBonsaiExecutions,
} from "../src/core/bonsai/executions.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("Bonsai child executions", () => {
	it("keeps child transcripts out of resume while allowing lookup by execution ref", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bonsai-executions-"));
		const parent = SessionManager.create(dir, dir, { id: "root-session" });
		parent.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "root" }],
			api: "test-api",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const child = createBonsaiChildSessionManager(parent, dir);
		child.appendMessage({ role: "user", content: [{ type: "text", text: "inspect" }], timestamp: Date.now() });
		child.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "evidence" }],
			api: "test-api",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const listed = await SessionManager.listAll(dir);
		expect(listed.map((session) => session.id)).toEqual(["root-session"]);
		const childPath = findBonsaiChildSessionFile(parent, child.getSessionId());
		expect(childPath).toBe(child.getSessionFile());
		expect(readFileSync(childPath!, "utf8")).toContain('"evidence"');
		expect(openBonsaiChildTranscript(parent, child.getSessionId())?.getSessionId()).toBe(child.getSessionId());
	});

	it("publishes bounded lifecycle snapshots and releases the live child", () => {
		const owner = {};
		let childListener: AgentSessionEventListener | undefined;
		const child = {
			sessionId: "child-1",
			sessionFile: "/tmp/child-1.jsonl",
			subscribe(listener: AgentSessionEventListener) {
				childListener = listener;
				return () => {
					childListener = undefined;
				};
			},
		};
		const listener = vi.fn();
		const unsubscribe = subscribeBonsaiExecutions(owner, listener);
		const handle = registerBonsaiExecution(owner, child, {
			operationId: "delegate-call-1",
			kind: "delegate",
			label: "inspect parser",
			nodeId: [1, 2],
			profile: "explorer",
		});

		expect(getBonsaiExecutions(owner)).toMatchObject([
			{
				executionRef: "child-1",
				operationId: "delegate-call-1",
				status: "waiting",
				toolCalls: 0,
				nodeId: [1, 2],
			},
		]);
		expect(getRunningBonsaiExecution(owner, "child-1")).toBe(child);
		childListener?.({ type: "agent_start" });
		childListener?.({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {} });
		expect(getBonsaiExecutions(owner)[0]).toMatchObject({ status: "running", toolCalls: 1 });

		handle.finish("completed");
		expect(getBonsaiExecutions(owner)[0]).toMatchObject({ status: "completed" });
		expect(getBonsaiExecutions(owner)[0]?.finishedAt).toEqual(expect.any(Number));
		expect(getRunningBonsaiExecution(owner, "child-1")).toBeUndefined();
		expect(childListener).toBeUndefined();
		expect(listener).toHaveBeenCalledTimes(4);
		unsubscribe();
	});
});
