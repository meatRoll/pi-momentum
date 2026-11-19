/**
 * Momentum settings — one file, two scopes.
 *
 *   ~/.pi/agent/momentum.json
 *
 *   {
 *     "global":      { "never": [...], "model": "provider/id", "maxContinues": 3 },
 *     "directories": {
 *       "/abs/path/to/project": { "never": [...], "replace": true }
 *     }
 *   }
 *
 * There is exactly one directory scope: the working directory, matched exactly.
 * No `.pi/momentum.json` files anywhere — a rule lives in one place, so "where is
 * that rule" has one answer, and a stray file in a parent directory cannot
 * change behaviour you cannot see.
 *
 * A rule is either a plain string or `{ "text": ..., "terms": [...] }`, where
 * `terms` are the phrases whose presence in a reply violates the rule.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Scope = "global" | "dir";

/** A rule as stored: plain text, or text plus match terms. */
export type NeverEntry = string | { text: string; terms?: readonly string[] };

export interface NeverRule {
	text: string;
	/** Phrases whose presence in a reply violates the rule. */
	terms?: string[];
	/** Which scope declared it. */
	scope: Scope;
}

export interface MomentumConfig {
	/** Effective rules, global first. */
	never: string[];
	/** Rules with their origin. */
	rules: NeverRule[];
	/** True when the directory scope shadows the global list. */
	replace: boolean;
	model?: string;
	maxContinues?: number;
	/** Absolute path of the settings file. */
	storePath: string;
	/** Key the directory scope is stored under. */
	dirKey: string;
	/** Whether this directory has an entry of its own. */
	hasDirEntry: boolean;
}

interface ScopeConfig {
	never?: unknown;
	replace?: unknown;
	model?: unknown;
	maxContinues?: unknown;
}

interface StoreFile {
	global?: ScopeConfig;
	directories?: Record<string, ScopeConfig>;
}

export function storePath(): string {
	return join(homedir(), ".pi", "agent", "momentum.json");
}

/**
 * The key a directory is stored under. Realpath so a symlinked or case-folded
 * path does not create a second entry for the same place.
 */
export function dirKey(cwd: string): string {
	const absolute = resolve(cwd);
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}

function readStore(path: string): StoreFile {
	if (!existsSync(path)) return {};
	try {
		return (JSON.parse(readFileSync(path, "utf8")) as StoreFile) ?? {};
	} catch {
		return {};
	}
}

/** Write via a temp file so a crash cannot truncate the only copy of the rules. */
function writeStore(path: string, store: StoreFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const payload = `${JSON.stringify(store, null, 2)}\n`;
	const temp = `${path}.tmp`;
	writeFileSync(temp, payload);
	renameSync(temp, path);
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Normalise the many shapes a rule can be written in. */
export function neverEntries(value: unknown): Array<{ text: string; terms?: string[] }> {
	if (!Array.isArray(value)) return [];
	const out: Array<{ text: string; terms?: string[] }> = [];
	for (const item of value) {
		if (typeof item === "string") {
			if (item.trim()) out.push({ text: item.trim() });
			continue;
		}
		if (!item || typeof item !== "object") continue;
		const { text, terms } = item as { text?: unknown; terms?: unknown };
		if (typeof text !== "string" || !text.trim()) continue;
		const parsed = strings(terms).map((term) => term.trim()).filter(Boolean);
		out.push({ text: text.trim(), ...(parsed.length > 0 ? { terms: parsed } : {}) });
	}
	return out;
}

function collect(value: unknown, scope: Scope, rules: NeverRule[]): void {
	for (const declared of neverEntries(value)) {
		const key = declared.text.trim().toLowerCase();
		if (!key) continue;
		const existing = rules.findIndex((rule) => rule.text.trim().toLowerCase() === key);
		// The directory scope owns a duplicate and keeps its position.
		const rule: NeverRule = { ...declared, scope };
		if (existing >= 0) rules[existing] = rule;
		else rules.push(rule);
	}
}

export function loadConfig(cwd: string): MomentumConfig {
	const path = storePath();
	const store = readStore(path);
	const key = dirKey(cwd);
	const dir = store.directories?.[key];

	const rules: NeverRule[] = [];
	const replace = dir?.replace === true;
	if (!replace) collect(store.global?.never, "global", rules);
	collect(dir?.never, "dir", rules);

	const model =
		typeof dir?.model === "string"
			? dir.model
			: typeof store.global?.model === "string"
				? store.global.model
				: undefined;
	const maxContinues =
		typeof dir?.maxContinues === "number"
			? dir.maxContinues
			: typeof store.global?.maxContinues === "number"
				? store.global.maxContinues
				: undefined;

	return {
		never: rules.map((rule) => rule.text),
		rules,
		replace,
		model,
		maxContinues,
		storePath: path,
		dirKey: key,
		hasDirEntry: Boolean(dir),
	};
}

function scopeOf(store: StoreFile, key: string, scope: Scope): ScopeConfig {
	if (scope === "global") return (store.global ??= {});
	store.directories ??= {};
	return (store.directories[key] ??= {});
}

/** Append a rule to one scope. Returns the path written. */
export function addNever(config: MomentumConfig, entry: NeverEntry, scope: Scope): string {
	const store = readStore(config.storePath);
	const target = scopeOf(store, config.dirKey, scope);
	const existing = Array.isArray(target.never) ? (target.never as unknown[]) : [];
	target.never = [...existing, entry];
	writeStore(config.storePath, store);
	return config.storePath;
}

/** Remove a rule from the scope that declares it. */
export function removeNever(config: MomentumConfig, text: string): boolean {
	const rule = config.rules.find((item) => item.text === text);
	if (!rule) return false;
	const store = readStore(config.storePath);
	const target = scopeOf(store, config.dirKey, rule.scope);
	const kept = (Array.isArray(target.never) ? (target.never as unknown[]) : []).filter((item) => {
		const declared = neverEntries([item])[0];
		return declared?.text !== text;
	});
	target.never = kept;
	writeStore(config.storePath, store);
	return true;
}

/** Directories with their own rules, for `/momentum dirs`. */
export function listDirectories(config: MomentumConfig): Array<{ key: string; rules: number }> {
	const store = readStore(config.storePath);
	return Object.entries(store.directories ?? {}).map(([key, value]) => ({
		key,
		rules: neverEntries(value?.never).length,
	}));
}

/** A legacy per-directory file, if one is still sitting in the working directory. */
export function legacyConfigPath(cwd: string): string | undefined {
	const path = join(resolve(cwd), ".pi", "momentum.json");
	return existsSync(path) ? path : undefined;
}
