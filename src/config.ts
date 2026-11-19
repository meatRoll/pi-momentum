/**
 * Momentum settings, scoped per repository.
 *
 *   global  ~/.pi/agent/momentum.json        personal, applies everywhere
 *   repo    <git-root>/.pi/momentum.json     this repository only
 *
 * The repo file is resolved from the **git root**, not the working directory, so
 * starting Pi in a subdirectory still finds the rules that belong to the repo.
 *
 * {
 *   "never": ["不要碰 vendor/", "不许改数据库迁移"],
 *   "replace": false,          // true: ignore the global list entirely
 *   "model": "provider/modelId",
 *   "maxContinues": 3
 * }
 *
 * Never-lists merge by default: universal no-go rules ("don't delete data")
 * should not disappear just because a repo has its own list. `replace` exists
 * for the repository that genuinely needs a clean slate.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type NeverScope = "global" | "repo";

export interface NeverRule {
	text: string;
	scope: NeverScope;
}

export interface MomentumConfig {
	/** Effective rules, in prompt order. */
	never: string[];
	/** Rules with their origin, for `/momentum never list`. */
	rules: NeverRule[];
	/** True when the repo list shadows the global one. */
	replace: boolean;
	/** Model for the virtual-user call, as "provider/modelId". Default: active model. */
	model?: string;
	/** Cap on automatic continuations per user turn. */
	maxContinues?: number;
	/** Git root the repo rules belong to, when there is one. */
	repoRoot?: string;
	repoConfigPath?: string;
	globalConfigPath: string;
}

interface RawConfig {
	never?: unknown;
	replace?: unknown;
	model?: unknown;
	maxContinues?: unknown;
}

export function globalConfigPath(): string {
	return join(homedir(), ".pi", "agent", "momentum.json");
}

/** Nearest ancestor containing `.git`, or undefined outside a repository. */
export function findRepoRoot(cwd: string): string | undefined {
	let current = resolve(cwd);
	for (let depth = 0; depth < 40; depth++) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

export function repoConfigPath(repoRoot: string): string {
	return join(repoRoot, ".pi", "momentum.json");
}

function readConfigFile(path: string | undefined): RawConfig {
	if (!path || !existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as RawConfig;
	} catch {
		return {};
	}
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Merge global then repo. Repo `replace: true` shadows the global list. */
export function loadConfig(cwd: string): MomentumConfig {
	const repoRoot = findRepoRoot(cwd);
	const globalPath = globalConfigPath();
	const repoPath = repoRoot ? repoConfigPath(repoRoot) : undefined;

	const globalRaw = readConfigFile(globalPath);
	const repoRaw = readConfigFile(repoPath);
	const replace = repoRaw.replace === true;

	const rules: NeverRule[] = [];
	if (!replace) {
		for (const text of strings(globalRaw.never)) rules.push({ text, scope: "global" });
	}
	for (const text of strings(repoRaw.never)) rules.push({ text, scope: "repo" });

	const seen = new Set<string>();
	const deduped = rules.filter((rule) => {
		const key = rule.text.trim().toLowerCase();
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	return {
		never: deduped.map((rule) => rule.text),
		rules: deduped,
		replace,
		model:
			typeof repoRaw.model === "string" ? repoRaw.model : typeof globalRaw.model === "string" ? globalRaw.model : undefined,
		maxContinues:
			typeof repoRaw.maxContinues === "number"
				? repoRaw.maxContinues
				: typeof globalRaw.maxContinues === "number"
					? globalRaw.maxContinues
					: undefined,
		repoRoot,
		repoConfigPath: repoPath,
		globalConfigPath: globalPath,
	};
}

/** Read-modify-write a config file, preserving keys this extension does not own. */
export function writeNever(path: string, never: string[]): void {
	const existing = readConfigFile(path) as Record<string, unknown>;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...existing, never }, null, 2)}\n`);
}

function readNever(path: string): string[] {
	return strings(readConfigFile(path).never);
}

/** Append a rule to one scope. Returns the path written, or undefined when there is no repo. */
export function addNever(config: MomentumConfig, text: string, scope: NeverScope): string | undefined {
	const path = scope === "global" ? config.globalConfigPath : config.repoConfigPath;
	if (!path) return undefined;
	writeNever(path, [...readNever(path), text]);
	return path;
}

/** Remove a rule from whichever scope declares it. */
export function removeNever(config: MomentumConfig, text: string, scope: NeverScope): string | undefined {
	const path = scope === "global" ? config.globalConfigPath : config.repoConfigPath;
	if (!path) return undefined;
	const next = readNever(path).filter((item) => item !== text);
	writeNever(path, next);
	return path;
}
