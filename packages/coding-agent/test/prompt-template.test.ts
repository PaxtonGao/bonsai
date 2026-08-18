import { describe, expect, test } from "vitest";
import { renderPromptTemplate } from "../src/core/prompt-template.ts";

describe("renderPromptTemplate", () => {
	test("replaces Bonsai placeholders", () => {
		expect(renderPromptTemplate("Tools:\n{{BONSAI_TOOLS}}\n", { BONSAI_TOOLS: "- read" })).toBe("Tools:\n- read");
	});

	test("rejects missing and malformed template placeholders", () => {
		expect(() => renderPromptTemplate("{{BONSAI_TOOLS}}", {})).toThrow("Missing prompt template value");
		expect(() => renderPromptTemplate("{{BONSAI_tools}}", {})).toThrow("Invalid prompt template placeholder");
		expect(() => renderPromptTemplate("{{OTHER_PLACEHOLDER}}", {})).toThrow("Invalid prompt template placeholder");
	});

	test("does not interpret placeholders inside inserted values", () => {
		expect(renderPromptTemplate("{{BONSAI_CONTENT}}", { BONSAI_CONTENT: "Example: {{BONSAI_UNKNOWN}}" })).toBe(
			"Example: {{BONSAI_UNKNOWN}}",
		);
	});
});
