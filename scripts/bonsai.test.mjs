import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const launcherSource = fileURLToPath(new URL("./bonsai", import.meta.url));

async function withLauncher(run) {
	const root = await mkdtemp(join(tmpdir(), "bonsai-launcher-"));
	const launcher = join(root, "scripts", "bonsai");
	await mkdir(dirname(launcher), { recursive: true });
	await copyFile(launcherSource, launcher);
	await chmod(launcher, 0o755);
	await writeFile(join(root, "pi-test.sh"), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@"\n', { mode: 0o755 });
	try {
		await run({
			root,
			invoke: (args) => {
				const result = spawnSync(launcher, args, { encoding: "utf8" });
				assert.equal(result.status, 0, result.stderr);
				return result.stdout.trim().split("\n");
			},
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("loads ask_user_question for agent sessions", async () => {
	await withLauncher(async ({ invoke }) => {
		const args = invoke(["-p", "test"]);
		assert.equal(args[0], "--extension");
		assert.ok(args[1].endsWith("/.pi/npm/node_modules/@juicesharp/rpiv-ask-user-question/index.ts"));
		assert.deepEqual(args.slice(2), ["-p", "test"]);
	});
});

test("passes first-argument management commands through unchanged", async () => {
	await withLauncher(async ({ invoke }) => {
		for (const args of [
			["auth", "print-api-key", "--provider", "openai"],
			["install", "npm:example"],
			["remove", "npm:example"],
			["uninstall", "npm:example"],
			["update", "--extensions"],
			["list"],
			["config"],
		]) {
			assert.deepEqual(invoke(args), args);
		}
	});
});
