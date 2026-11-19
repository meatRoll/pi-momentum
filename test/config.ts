/**
 * Config scoping cases: repo root discovery, merge, replace, add/remove.
 *
 *   node --experimental-strip-types test/config.ts
 *
 * Runs against a throwaway HOME and a throwaway git repo, so nothing touches the
 * real ~/.pi/agent.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNever, findRepoRoot, globalConfigPath, loadConfig, removeNever, repoConfigPath } from "../src/config.ts";

const root = mkdtempSync(join(tmpdir(), "pi-momentum-config-"));
process.env.HOME = join(root, "home");

const repo = join(root, "repo");
const nested = join(repo, "packages", "deep", "src");
const outside = join(root, "elsewhere");
for (const dir of [nested, outside, join(root, "home", ".pi", "agent")]) mkdirSync(dir, { recursive: true });
mkdirSync(join(repo, ".git"));
mkdirSync(join(repo, ".pi"), { recursive: true });

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function reset(): void {
	writeJson(globalConfigPath(), { never: [] });
	writeJson(repoConfigPath(repo), { never: [] });
}

interface Case {
	name: string;
	run: () => boolean;
}

const cases: Case[] = [
	{
		name: "repo root is found from a nested directory",
		run: () => findRepoRoot(nested) === repo,
	},
	{
		name: "no repo root outside a repository",
		run: () => findRepoRoot(outside) === undefined,
	},
	{
		name: "global and repo lists merge, repo after global",
		run: () => {
			reset();
			writeJson(globalConfigPath(), { never: ["别删数据"] });
			writeJson(repoConfigPath(repo), { never: ["别碰 vendor/"] });
			const config = loadConfig(nested);
			return JSON.stringify(config.never) === JSON.stringify(["别删数据", "别碰 vendor/"]);
		},
	},
	{
		name: "each rule reports its scope",
		run: () => {
			reset();
			writeJson(globalConfigPath(), { never: ["G"] });
			writeJson(repoConfigPath(repo), { never: ["R"] });
			const config = loadConfig(nested);
			return config.rules[0]?.scope === "global" && config.rules[1]?.scope === "repo";
		},
	},
	{
		name: "replace: true shadows the global list",
		run: () => {
			reset();
			writeJson(globalConfigPath(), { never: ["G"] });
			writeJson(repoConfigPath(repo), { never: ["R"], replace: true });
			const config = loadConfig(nested);
			return JSON.stringify(config.never) === JSON.stringify(["R"]) && config.replace === true;
		},
	},
	{
		name: "duplicates across scopes collapse",
		run: () => {
			reset();
			writeJson(globalConfigPath(), { never: ["同一个"] });
			writeJson(repoConfigPath(repo), { never: ["同一个"] });
			return loadConfig(nested).never.length === 1;
		},
	},
	{
		name: "repo rules are ignored outside the repository",
		run: () => {
			reset();
			writeJson(globalConfigPath(), { never: ["G"] });
			writeJson(repoConfigPath(repo), { never: ["R"] });
			return JSON.stringify(loadConfig(outside).never) === JSON.stringify(["G"]);
		},
	},
	{
		name: "addNever appends to the repo file and keeps other keys",
		run: () => {
			reset();
			writeJson(repoConfigPath(repo), { never: ["A"], model: "p/m" });
			const config = loadConfig(nested);
			addNever(config, "B", "repo");
			const written = JSON.parse(readFileSync(repoConfigPath(repo), "utf8")) as {
				never: string[];
				model?: string;
			};
			return JSON.stringify(written.never) === JSON.stringify(["A", "B"]) && written.model === "p/m";
		},
	},
	{
		name: "addNever --global writes the user file, not the repo file",
		run: () => {
			reset();
			const config = loadConfig(nested);
			addNever(config, "personal", "global");
			const global = JSON.parse(readFileSync(globalConfigPath(), "utf8")) as { never: string[] };
			const repoFile = JSON.parse(readFileSync(repoConfigPath(repo), "utf8")) as { never: string[] };
			return (
				JSON.stringify(global.never) === JSON.stringify(["personal"]) &&
				JSON.stringify(repoFile.never) === JSON.stringify([])
			);
		},
	},
	{
		name: "removeNever removes only the named rule",
		run: () => {
			reset();
			writeJson(repoConfigPath(repo), { never: ["A", "B", "C"] });
			removeNever(loadConfig(nested), "B", "repo");
			const written = JSON.parse(readFileSync(repoConfigPath(repo), "utf8")) as { never: string[] };
			return JSON.stringify(written.never) === JSON.stringify(["A", "C"]);
		},
	},
	{
		name: "a broken config file does not throw",
		run: () => {
			reset();
			writeFileSync(repoConfigPath(repo), "{ not json");
			return loadConfig(nested).never.length === 0;
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
