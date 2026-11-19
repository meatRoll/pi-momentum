/**
 * Config store cases: one file, two scopes, exact directory match.
 *
 *   node --experimental-strip-types test/config.ts
 *
 * Runs against a throwaway HOME, so nothing touches the real ~/.pi/agent.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addNever,
	dirKey,
	legacyConfigPath,
	listDirectories,
	loadConfig,
	removeNever,
	storePath,
} from "../src/config.ts";

const ROOT = mkdtempSync(join(tmpdir(), "pi-momentum-store-"));
process.env.HOME = join(ROOT, "home");
mkdirSync(join(ROOT, "home", ".pi", "agent"), { recursive: true });

const A = join(ROOT, "alpha");
const B = join(ROOT, "beta");
for (const dir of [A, B]) mkdirSync(dir, { recursive: true });

interface Store {
	global?: { never?: unknown[]; model?: string; maxContinues?: number };
	directories?: Record<string, { never?: unknown[]; replace?: boolean; model?: string }>;
}

function readStore(): Store {
	return JSON.parse(readFileSync(storePath(), "utf8")) as Store;
}

function reset(store: Store = {}): void {
	writeFileSync(storePath(), JSON.stringify(store, null, 2));
}

interface Case {
	name: string;
	run: () => boolean;
}

const cases: Case[] = [
	{
		name: "no store file means no rules",
		run: () => {
		const config = loadConfig(A);
		return config.never.length === 0 && config.hasDirEntry === false;
	},
	},
	{
		name: "storePath is the single file under $HOME",
		run: () => storePath() === join(ROOT, "home", ".pi", "agent", "momentum.json"),
	},
	{
		name: "global rules apply to every directory",
		run: () => {
			reset({ global: { never: ["g"] } });
			return loadConfig(A).never.includes("g") && loadConfig(B).never.includes("g");
		},
	},
	{
		name: "directory rules apply to that directory only",
		run: () => {
			reset({ directories: { [dirKey(A)]: { never: ["only-a"] } } });
			return loadConfig(A).never.includes("only-a") && !loadConfig(B).never.includes("only-a");
		},
	},
	{
		name: "directory rules follow the global ones",
		run: () => {
			reset({
				global: { never: ["g"] },
				directories: { [dirKey(A)]: { never: ["d"] } },
			});
			return JSON.stringify(loadConfig(A).never) === JSON.stringify(["g", "d"]);
		},
	},
	{
		name: "replace: true drops the global list",
		run: () => {
			reset({
				global: { never: ["g"] },
				directories: { [dirKey(A)]: { never: ["d"], replace: true } },
			});
			const config = loadConfig(A);
			return JSON.stringify(config.never) === JSON.stringify(["d"]) && config.replace === true;
		},
	},
	{
		name: "a duplicate is owned by the directory scope",
		run: () => {
			reset({
				global: { never: ["same"] },
				directories: { [dirKey(A)]: { never: ["same"] } },
			});
			const config = loadConfig(A);
			return config.never.length === 1 && config.rules[0]?.scope === "dir";
		},
	},
	{
		name: "a rule can carry explicit match terms",
		run: () => {
			reset({ global: { never: [{ text: "不许改迁移", terms: ["数据库迁移"] }] } });
			const rule = loadConfig(A).rules[0];
			return rule?.text === "不许改迁移" && JSON.stringify(rule.terms) === JSON.stringify(["数据库迁移"]);
		},
	},
	{
		name: "scalars fall back from directory to global",
		run: () => {
			reset({ global: { model: "p/global", maxContinues: 2 } });
			const globalOnly = loadConfig(B);
			reset({
				global: { model: "p/global", maxContinues: 2 },
				directories: { [dirKey(A)]: { never: [], model: "p/dir" } },
			});
			const dir = loadConfig(A);
			return globalOnly.model === "p/global" && dir.model === "p/dir" && dir.maxContinues === 2;
		},
	},
	{
		name: "addNever without a flag writes the directory scope",
		run: () => {
			reset();
			addNever(loadConfig(A), "dir-rule", "dir");
			const store = readStore();
			return JSON.stringify(store.directories?.[dirKey(A)]?.never) === JSON.stringify(["dir-rule"]) &&
				store.global === undefined;
		},
	},
	{
		name: "addNever --global writes the global scope",
		run: () => {
			reset();
			addNever(loadConfig(A), "global-rule", "global");
			const store = readStore();
			return JSON.stringify(store.global?.never) === JSON.stringify(["global-rule"]) &&
				store.directories === undefined;
		},
	},
	{
		name: "adding to one directory leaves other directories alone",
		run: () => {
			reset();
			addNever(loadConfig(A), "a-rule", "dir");
			addNever(loadConfig(B), "b-rule", "dir");
			const store = readStore();
			return (
				JSON.stringify(store.directories?.[dirKey(A)]?.never) === JSON.stringify(["a-rule"]) &&
				JSON.stringify(store.directories?.[dirKey(B)]?.never) === JSON.stringify(["b-rule"])
			);
		},
	},
	{
		name: "removeNever edits the scope that declares the rule",
		run: () => {
			reset({
				global: { never: ["g"] },
				directories: { [dirKey(A)]: { never: ["d", "d2"] } },
			});
			removeNever(loadConfig(A), "g");
			removeNever(loadConfig(A), "d");
			const store = readStore();
			return (
				JSON.stringify(store.global?.never) === JSON.stringify([]) &&
				JSON.stringify(store.directories?.[dirKey(A)]?.never) === JSON.stringify(["d2"])
			);
		},
	},
	{
		name: "an object rule is written back as an object",
		run: () => {
			reset();
			addNever(loadConfig(A), { text: "带词的", terms: ["甲", "乙"] }, "global");
			const store = readStore();
			const entry = store.global?.never?.[0] as { text?: string; terms?: string[] };
			return entry?.text === "带词的" && JSON.stringify(entry.terms) === JSON.stringify(["甲", "乙"]);
		},
	},
	{
		name: "writing keeps keys the extension does not own",
		run: () => {
			reset({ global: { never: [], model: "p/m" } } as Store);
			addNever(loadConfig(A), "x", "global");
			const store = readStore();
			return store.global?.model === "p/m";
		},
	},
	{
		name: "no temp file is left behind",
		run: () => {
			reset();
			addNever(loadConfig(A), "x", "dir");
			return !existsSync(`${storePath()}.tmp`);
		},
	},
	{
		name: "a broken store file does not throw",
		run: () => {
			writeFileSync(storePath(), "{ not json");
			return loadConfig(A).never.length === 0;
		},
	},
	{
		name: "listDirectories reports each directory and its count",
		run: () => {
			reset({
				directories: {
					[dirKey(A)]: { never: ["a", "b"] },
					[dirKey(B)]: { never: ["c"] },
				},
			});
			const dirs = listDirectories(loadConfig(A));
			return dirs.length === 2 && dirs.some((dir) => dir.key === dirKey(A) && dir.rules === 2);
		},
	},
	{
		name: "dirKey collapses . and .. segments",
		run: () => dirKey(join(A, ".", "..", "alpha")) === dirKey(A),
	},
	{
		name: "a legacy .pi/momentum.json is detected",
		run: () => {
			mkdirSync(join(B, ".pi"), { recursive: true });
			writeFileSync(join(B, ".pi", "momentum.json"), "{}");
			return legacyConfigPath(B) === join(B, ".pi", "momentum.json") && legacyConfigPath(A) === undefined;
		},
	},
];

let failures = 0;
for (const testCase of cases) {
	let ok = false;
	try {
		ok = testCase.run();
	} catch (error) {
		console.log(`FAIL  ${testCase.name}  → threw ${String(error)}`);
		failures++;
		continue;
	}
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${testCase.name}`);
}

console.log();
if (failures > 0) {
	console.error(`${failures} case(s) failed`);
	process.exit(1);
}
console.log(`${cases.length}/${cases.length} config cases pass`);
