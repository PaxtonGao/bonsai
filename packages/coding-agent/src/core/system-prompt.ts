/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { loadPromptTemplate } from "./prompt-template.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	const projectContext =
		contextFiles.length > 0
			? `\n\n${loadPromptTemplate("internal/project-context", {
					BONSAI_PROJECT_INSTRUCTIONS: contextFiles
						.map(({ path: filePath, content }) =>
							loadPromptTemplate("internal/project-instruction", {
								BONSAI_PROJECT_PATH: filePath,
								BONSAI_PROJECT_CONTENT: content,
							}),
						)
						.join("\n\n"),
				})}`
			: "";

	if (customPrompt) {
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		return loadPromptTemplate("internal/custom-system", {
			BONSAI_CUSTOM_SYSTEM: customPrompt,
			BONSAI_APPEND_SYSTEM: appendSection,
			BONSAI_PROJECT_CONTEXT: projectContext,
			BONSAI_SKILLS: customPromptHasRead && skills.length > 0 ? formatSkillsForPrompt(skills) : "",
			BONSAI_CWD: promptCwd,
		});
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	return loadPromptTemplate("agents/main", {
		BONSAI_TOOLS: toolsList,
		BONSAI_GUIDELINES: guidelines,
		BONSAI_README_PATH: readmePath,
		BONSAI_DOCS_PATH: docsPath,
		BONSAI_EXAMPLES_PATH: examplesPath,
		BONSAI_APPEND_SYSTEM: appendSection,
		BONSAI_PROJECT_CONTEXT: projectContext,
		BONSAI_SKILLS: hasRead && skills.length > 0 ? formatSkillsForPrompt(skills) : "",
		BONSAI_CWD: promptCwd,
	});
}
