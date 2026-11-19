/**
 * Momentum settings, layered by directory path.
 *
 * Every ancestor of the working directory may own a `.pi/momentum.json`.
 * Layers are folded shallow to deep, so the nearest file wins for scalars and
 * the deepest list is the one that cannot be overridden:
 *
 *   ~/.pi/agent/momentum.json        personal, applies everywhere
 *   <root>/.pi/momentum.json         the whole project
 *   <root>/packages/foo/.pi/momentum.json    just this package
 *
 * There is no `.git` sniffing: a layer is simply a directory that has the file.
 * A monorepo package and its root are two scopes, not one.
 *
 * {
 *   "never": [
 *     "不要碰 vendor/",
 *     { "text": "不许改数据库迁移", "terms": ["数据库迁移", "迁移脚本"] }
 *   ],
 *   "replace": true,           // drop every shallower layer's list
 *   "model": "provider/modelId",
 *   "maxContinues": 3
 * }
 *
 * A rule is either a plain string (writing the rule as a person would) or an
 * object with `terms`: the phrases that, appearing in a reply, mean the rule was
 * violated. `terms` is optional — without it the terms are derived heuristically.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

export interface ConfigLayer {
	/** "global" for the user file, otherwise the directory that owns it. */
	root: string;
	file: string;
	global: boolean;
}

/** A rule as stored: plain text, or text plus match terms. */
export type NeverEntry = string | { text: string; terms?: readonly string[] };

export interface NeverRule {
	text: string;
	/** Phrases whose presence in a reply violates the rule. */
	terms?: string[];
	/** Config file that declares it. */
	file: string;
	layer: "global" | "local";
}

export interface MomentumConfig {
	/** Effective rules, shallowest first. */
	never: string[];
	/** Rules with their origin, for `/momentum never list`. */
	rules: NeverRule[];
	/** True when some layer asked to drop the shallower lists. */
	replace: boolean;
	/** Model for the virtual-user call, as "provider/modelId". Default: active model. */
	model?: string;
	/** Cap on automatic continuations per user turn. */
	maxContinues?: number;
	/** Loaded layers, shallowest first. */
	layers: ConfigLayer[];
	/** Deepest local layer, when one exists. */
	localRoot?: string;
	globalConfigPath: string;
}

interface RawConfig {
	never?: unknown;
	replace?: unknown;
	model?: unknown;
	maxContinues?: unknown;
}

const MAX_DEPTH = 64;

export function globalConfigPath(): string {
	return join(homedir(), ".pi", "agent", "momentum.json");
}

export function layerConfigPath(dir: string): string {
	return join(dir, ".pi", "momentum.json");
}

/**
 * Every directory from cwd up to the filesystem root that owns a config file,
 * ordered shallowest first so the caller can fold over them.
 */
export function findLocalLayers(cwd: string): Array<{ root: string; file: string }> {
	const found: Array<{ root: string; file: string }> = [];
	let current = resolve(cwd);
	for (let depth = 0; depth < MAX_DEPTH; depth++) {
		const file = layerConfigPath(current);
		if (existsSync(file)) found.push({ root: current, file });
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return found.reverse();
}

function readRaw(path: string): RawConfig {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as RawConfig;
	} catch {
		return {};
	}
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Normalise the many shapes `never` can be written in. */
export function neverEntries(value: unknown): NeverRule[] {
	if (!Array.isArray(value)) return [];
	const out: NeverRule[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			if (item.trim()) out.push({ text: item.trim(), file: "", layer: "local" });
			continue;
		}
		if (!item || typeof item !== "object") continue;
		const { text, terms } = item as { text?: unknown; terms?: unknown };
		if (typeof text !== "string" || !text.trim()) continue;
		const parsedTerms = strings(terms).map((term) => term.trim()).filter(Boolean);
		out.push({
			text: text.trim(),
			...(parsedTerms.length > 0 ? { terms: parsedTerms } : {}),
			file: "",
			layer: "local",
		});
	}
	return out;
}

/** Fold the layers shallow to deep. */
export function loadConfig(cwd: string): MomentumConfig {
	const globalFile = globalConfigPath();
	const layers: ConfigLayer[] = [{ root: "global", file: globalFile, global: true }];
	const local = findLocalLayers(cwd);
	for (const entry of local) layers.push({ root: entry.root, file: entry.file, global: false });

	const rules: NeverRule[] = [];
	let replace = false;
	let model: string | undefined;
	let maxContinues: number | undefined;

	for (const layer of layers) {
		if (!existsSync(layer.file)) continue;
		const raw = readRaw(layer.file);

		// A layer that sets replace: true discards everything shallower.
		if (raw.replace === true) {
			rules.length = 0;
			replace = true;
		}

		for (const declared of neverEntries(raw.never)) {
			const key = declared.text.trim().toLowerCase();
			if (!key) continue;
			const existing = rules.findIndex((rule) => rule.text.trim().toLowerCase() === key);
			const rule: NeverRule = {
				text: declared.text,
				...(declared.terms ? { terms: declared.terms } : {}),
				file: layer.file,
				layer: layer.global ? "global" : "local",
			};
			// Deeper declarations take ownership of a duplicate, keeping its position.
			if (existing >= 0) rules[existing] = rule;
			else rules.push(rule);
		}

		if (typeof raw.model === "string") model = raw.model;
		if (typeof raw.maxContinues === "number") maxContinues = raw.maxContinues;
	}

	return {
		never: rules.map((rule) => rule.text),
		rules,
		replace,
		model,
		maxContinues,
		layers,
		localRoot: local.at(-1)?.root,
		globalConfigPath: globalFile,
	};
}

/** Short label for a rule's origin: "global", the relative directory, or `…/name` when it escapes the cwd. */
export function originLabel(rule: NeverRule, cwd: string): string {
	if (rule.layer === "global") return "global";
	const dir = dirname(dirname(rule.file));
	const rel = relative(cwd, dir);
	if (!rel) return ".";
	if (!rel.startsWith("..")) return rel;
	return `…/${basename(dir)}`;
}

/** Read-modify-write a config file, preserving keys this extension does not own. */
/** Write the raw `never` array, preserving every other key in the file. */
export function writeNever(path: string, never: unknown[]): void {
	const existing = existsSync(path) ? (readRaw(path) as Record<string, unknown>) : {};
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...existing, never }, null, 2)}\n`);
}

/** The file's `never` value exactly as stored, so rewrites keep its shapes. */
function readRawNever(path: string): unknown[] {
	return existsSync(path) ? (Array.isArray(readRaw(path).never) ? (readRaw(path).never as unknown[]) : []) : [];
}

function ruleText(item: unknown): string | undefined {
	if (typeof item === "string") return item.trim() || undefined;
	if (item && typeof item === "object") {
		const { text } = item as { text?: unknown };
		if (typeof text === "string" && text.trim()) return text.trim();
	}
	return undefined;
}

/**
 * Where a new rule goes: the deepest local layer, or the working directory when
 * no layer exists yet. Pure path semantics — any directory can own a layer.
 */
export function localTarget(config: MomentumConfig, cwd: string, exact = false): string {
	if (exact) return layerConfigPath(resolve(cwd));
	return config.localRoot ? layerConfigPath(config.localRoot) : layerConfigPath(resolve(cwd));
}

export function addNever(
	config: MomentumConfig,
	cwd: string,
	entry: NeverEntry,
	scope: "global" | "local",
	exact = false,
): string {
	const path = scope === "global" ? config.globalConfigPath : localTarget(config, cwd, exact);
	writeNever(path, [...readRawNever(path), entry]);
	return path;
}

/** Remove a rule from the file that declares it. */
export function removeNever(config: MomentumConfig, text: string): string | undefined {
	const rule = config.rules.find((item) => item.text === text);
	if (!rule) return undefined;
	writeNever(
		rule.file,
		readRawNever(rule.file).filter((item) => ruleText(item) !== text),
	);
	return rule.file;
}
