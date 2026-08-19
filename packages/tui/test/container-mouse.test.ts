import assert from "node:assert/strict";
import test from "node:test";
import { type Component, type ComponentMouseEvent, Container } from "../src/tui.ts";

test("Container routes mouse events to the vertically rendered child", () => {
	let received: ComponentMouseEvent | undefined;
	const first: Component = { render: () => ["a", "b"], invalidate: () => {} };
	const second: Component = {
		render: () => ["c"],
		invalidate: () => {},
		handleMouse: (event) => {
			received = event;
			return true;
		},
	};
	const container = new Container();
	container.addChild(first);
	container.addChild(second);

	assert.equal(container.handleMouse({ x: 4, y: 7, localX: 4, localY: 2, width: 20, button: 0 }), true);
	assert.equal(received?.localY, 0);
	assert.equal(received?.width, 20);
});
