import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "../config.ts";

const PROMPT_PLACEHOLDER = /\{\{([^{}]+)\}\}/g;
const BONSAI_PLACEHOLDER_NAME = /^BONSAI_[A-Z0-9_]+$/;

export function renderPromptTemplate(template: string, values: Record<string, string>): string {
	return template
		.replace(PROMPT_PLACEHOLDER, (placeholder, name: string) => {
			if (!BONSAI_PLACEHOLDER_NAME.test(name))
				throw new Error(`Invalid prompt template placeholder: ${placeholder}`);
			const value = values[name];
			if (value === undefined) throw new Error(`Missing prompt template value: ${placeholder}`);
			return value;
		})
		.trimEnd();
}

export function loadPromptTemplate(name: string, values: Record<string, string> = {}): string {
	const template = readFileSync(join(getPackageDir(), "prompts", `${name}.md`), "utf8");
	return renderPromptTemplate(template, values);
}
