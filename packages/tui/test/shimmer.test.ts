import assert from "node:assert/strict";
import { test } from "node:test";
import { Shimmer } from "../src/components/shimmer.ts";
import type { TUI } from "../src/tui.ts";

test("shimmer animates graphemes and stops at terminal state", async () => {
	let renders = 0;
	const tui = { requestRender: () => renders++ } as unknown as TUI;
	const shimmer = new Shimmer(tui, "工具🌱", {
		dim: (text) => `<d>${text}</d>`,
		base: (text) => `<b>${text}</b>`,
		bright: (text) => `<x>${text}</x>`,
		intervalMs: 5,
	});

	shimmer.setActive(true);
	const first = shimmer.render(40).join("\n");
	await new Promise((resolve) => setTimeout(resolve, 12));
	const second = shimmer.render(40).join("\n");
	assert.notEqual(first, second);
	assert.match(second, /🌱/);
	assert.ok(renders > 0);

	shimmer.setActive(false);
	const stopped = shimmer.render(40).join("\n");
	await new Promise((resolve) => setTimeout(resolve, 12));
	assert.equal(shimmer.render(40).join("\n"), stopped);
	shimmer.dispose();
});

test("shimmer dispose stops future renders", async () => {
	let renders = 0;
	const tui = { requestRender: () => renders++ } as unknown as TUI;
	const shimmer = new Shimmer(tui, "running", {
		dim: (text) => text,
		base: (text) => text,
		bright: (text) => text,
		intervalMs: 5,
	});
	shimmer.setActive(true);
	await new Promise((resolve) => setTimeout(resolve, 8));
	shimmer.dispose();
	const stoppedAt = renders;
	await new Promise((resolve) => setTimeout(resolve, 12));
	assert.equal(renders, stoppedAt);
});

test("animation starts when text is set after activation with empty text", async () => {
	let renders = 0;
	const tui = { requestRender: () => renders++ } as unknown as TUI;
	const shimmer = new Shimmer(tui, "", {
		dim: (text) => `<d>${text}</d>`,
		base: (text) => `<b>${text}</b>`,
		bright: (text) => `<x>${text}</x>`,
		intervalMs: 5,
	});
	shimmer.setActive(true);
	shimmer.setText("running");
	const first = shimmer.render(40).join("\n");
	await new Promise((resolve) => setTimeout(resolve, 12));
	const second = shimmer.render(40).join("\n");
	assert.notEqual(first, second);
	assert.ok(renders > 0);
	shimmer.dispose();
});

test("trail palette colors the wave tail by distance from head", async () => {
	const tui = { requestRender: () => {} } as unknown as TUI;
	const shimmer = new Shimmer(tui, "abcde", {
		dim: (text) => `<d>${text}</d>`,
		base: (text) => `<b>${text}</b>`,
		bright: (text) => `<x>${text}</x>`,
		intervalMs: 5,
		trail: [(text) => `<a>${text}</a>`, (text) => `<c>${text}</c>`],
	});
	shimmer.setActive(true);
	// head at position 0: 'a' bright, 'b' trail[0], 'c' trail[1], rest dim
	const rendered = shimmer.render(40).join("\n");
	assert.match(rendered, /^<x>a<\/x><a>b<\/a><c>c<\/c><d>d<\/d><d>e<\/d>/);
	shimmer.dispose();
});

test("repeated activation does not reset the moving wave", async () => {
	const tui = { requestRender: () => {} } as unknown as TUI;
	const shimmer = new Shimmer(tui, "running", {
		dim: (text) => `<d>${text}</d>`,
		base: (text) => `<b>${text}</b>`,
		bright: (text) => `<x>${text}</x>`,
		intervalMs: 5,
	});
	shimmer.setActive(true);
	await new Promise((resolve) => setTimeout(resolve, 8));
	const before = shimmer.render(40).join("\n");
	shimmer.setActive(true);
	assert.equal(shimmer.render(40).join("\n"), before);
	shimmer.dispose();
});
