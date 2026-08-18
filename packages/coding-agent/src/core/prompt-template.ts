import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "../config.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";

const PROMPT_PLACEHOLDER = /\{\{([^{}]+)\}\}/g;
const BONSAI_PLACEHOLDER_NAME = /^BONSAI_[A-Z0-9_]+$/;
const TOOL_BRIEF_MARKER = "<!-- brief -->";
const TOOL_GUIDANCE_MARKER = "<!-- guidance -->";

export interface ToolPromptDoc {
	brief: string;
	guidance: string;
}

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
	return renderPromptTemplate(stripFrontmatter(template), values);
}

export function loadToolPromptDoc(name: string, values: Record<string, string> = {}): ToolPromptDoc {
	const template = readFileSync(join(getPackageDir(), "prompts", `${name}.md`), "utf8");
	const briefIndex = template.indexOf(TOOL_BRIEF_MARKER);
	const guidanceIndex = template.indexOf(TOOL_GUIDANCE_MARKER);
	if (
		briefIndex < 0 ||
		guidanceIndex <= briefIndex ||
		template.lastIndexOf(TOOL_BRIEF_MARKER) !== briefIndex ||
		template.lastIndexOf(TOOL_GUIDANCE_MARKER) !== guidanceIndex
	) {
		throw new Error(`Tool prompt must contain one brief followed by one guidance section: ${name}`);
	}

	const brief = template.slice(briefIndex + TOOL_BRIEF_MARKER.length, guidanceIndex).trim();
	const guidance = template.slice(guidanceIndex + TOOL_GUIDANCE_MARKER.length).trim();
	if (!brief || !guidance) throw new Error(`Tool prompt brief and guidance must be non-empty: ${name}`);
	if (/\{\{[^{}]+\}\}/.test(brief)) throw new Error(`Tool prompt brief cannot contain placeholders: ${name}`);

	return {
		brief,
		guidance: renderPromptTemplate(guidance, values),
	};
}
