/**
 * Momentum settings.
 *
 * Global:  ~/.pi/agent/momentum.json
 * Project: <cwd>/.pi/momentum.json   (wins, and is where edits are written)
 *
 * {
 *   "never": ["安装新软件", "删库"],
 *   "model": "provider/modelId",
 *   "maxContinues": 3
 * }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface MomentumConfig {
	/** Hard "never do this" list injected into the virtual-user prompt. */
	never: string[];
	/** Model for the virtual-user call, as "provider/modelId". Default: active model. */
	model?: string;
	/** Cap on automatic continuations per user turn. */
	maxContinues?: number;
}

interface RawConfig {
	never?: unknown;
	model?: unknown;
	maxContinues?: unknown;
}

export function globalConfigPath(): string {
	return join(homedir(), ".pi", "agent", "momentum.json");
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "momentum.json");
}

function readConfigFile(path: string): MomentumConfig {
	if (!existsSync(path)) return { never: [] };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as RawConfig;
		return {
			never: Array.isArray(raw.never) ? raw.never.filter((v): v is string => typeof v === "string") : [],
			model: typeof raw.model === "string" ? raw.model : undefined,
			maxContinues: typeof raw.maxContinues === "number" ? raw.maxContinues : undefined,
		};
	} catch {
		return { never: [] };
	}
}

/** Merge global then project. Never-lists accumulate; scalars let the project win. */
export function loadConfig(cwd: string): MomentumConfig {
	const global = readConfigFile(globalConfigPath());
	const project = readConfigFile(projectConfigPath(cwd));
	return {
		never: [...new Set([...global.never, ...project.never])],
		model: project.model ?? global.model,
		maxContinues: project.maxContinues ?? global.maxContinues,
	};
}

/** Write the project-scoped never list, preserving any other keys in the file. */
export function writeProjectNever(cwd: string, never: string[]): void {
	const path = projectConfigPath(cwd);
	let existing: RawConfig = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf8")) as RawConfig;
		} catch {
			existing = {};
		}
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...existing, never }, null, 2)}\n`);
}
