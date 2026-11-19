/**
 * Config layer cases: path discovery, folding, replace, add/remove.
 *
 *   node --experimental-strip-types test/config.ts
 *
 * Runs against a throwaway HOME and throwaway directories, so nothing touches
 * the real ~/.pi/agent. No .git is created anywhere: layers are pure paths.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addNever,
	findLocalLayers,
	globalConfigPath,
	layerConfigPath,
	loadConfig,
	originLabel,
	removeNever,
} from "../src/config.ts";

const root = mkdtempSync(join(tmpdir(), "pi-momentum-layers-"));
process.env.HOME = join(root, "home");

const project = join(root, "project");
const pkg = join(project, "packages", "foo");
const nested = join(pkg, "src");
for (const dir of [nested, join(root, "home", ".pi", "agent")]) mkdirSync(dir, { recursive: true });

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, "..", ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeLayer(dir: string, value: unknown): void {
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeJson(layerConfigPath(dir), value);
}

function readLayer(dir: string): { never?: string[]; model?: string } {
	return JSON.parse(readFileSync(layerConfigPath(dir), "utf8")) as { never?: string[]; model?: string };
}

function reset(): void {
	writeJson(globalConfigPath(), { never: [] });
	writeLayer(project, { never: [] });
	writeLayer(pkg, { never: [] });
	// Tests may create a layer at the working directory itself; leaving it behind
	// makes it the deepest layer for every later test.
	if (existsSync(layerConfigPath(nested))) rmSync(layerConfigPath(nested));
}

interface Case {
	name: string;
	run: () => boolean;
}

const cases: Case[] = [
	{
		name: "a layer is a directory with .pi/momentum.json, no .git needed",
		run: () => {
			reset();
			const dirs = findLocalLayers(nested).map((layer) => layer.root);
			return dirs.includes(project) && dirs.includes(pkg);
		},
	},
	{
		name: "layers are ordered shallowest first",
		run: () => {
			reset();
			const dirs = findLocalLayers(nested).map((layer) => layer.root);
			return dirs.indexOf(project) < dirs.indexOf(pkg);
		},
	},
	{
		name: "deep and shallow lists merge",
		run: () => {
			reset();
			writeLayer(project, { never: ["root-rule"] });
			writeLayer(pkg, { never: ["pkg-rule"] });
			const config = loadConfig(nested);
			return JSON.stringify(config.never) === JSON.stringify(["root-rule", "pkg-rule"]);
		},
	},
	{
		name: "global list sits below every local layer",
		run: () => {
			reset();
			writeJson(globalConfigPath(), { never: ["global-rule"] });
			writeLayer(pkg, { never: ["pkg-rule"] });
			const config = loadConfig(nested);
			return JSON.stringify(config.never) === JSON.stringify(["global-rule", "pkg-rule"]);
		},
	},
	{
		name: "originLabel names the layer directory",
		run: () => {
			reset();
			writeJson(globalConfigPath(), { never: ["g"] });
			writeLayer(pkg, { never: ["p"] });
			const config = loadConfig(nested);
			const labels = config.rules.map((rule) => originLabel(rule, nested));
			return labels[0] === "global" && labels[1] === "…/foo";
		},
	},
	{
		name: "deeper scalar wins",
		run: () => {
			reset();
			writeJson(globalConfigPath(), { model: "p/global" });
			writeLayer(project, { model: "p/root" });
			writeLayer(pkg, { model: "p/deep" });
			return loadConfig(nested).model === "p/deep";
		},
	},
	{
		name: "a deep replace:true drops the shallower lists",
		run: () => {
			reset();
			writeJson(globalConfigPath(), { never: ["g"] });
			writeLayer(project, { never: ["root"] });
			writeLayer(pkg, { never: ["pkg"], replace: true });
			const config = loadConfig(nested);
			return JSON.stringify(config.never) === JSON.stringify(["pkg"]) && config.replace === true;
		},
	},
	{
		name: "duplicates are owned by the deeper layer, position kept",
		run: () => {
			reset();
			writeLayer(project, { never: ["同一个", "root-only"] });
			writeLayer(pkg, { never: ["同一个"] });
			const config = loadConfig(nested);
			return JSON.stringify(config.never) === JSON.stringify(["同一个", "root-only"]) &&
				config.rules[0]?.file === layerConfigPath(pkg);
		},
	},
	{
		name: "a directory outside the chain contributes nothing",
		run: () => {
			reset();
			const other = join(root, "other");
			writeLayer(other, { never: ["other-rule"] });
			return !loadConfig(nested).never.includes("other-rule");
		},
	},
	{
		name: "addNever with no layer yet writes the working directory",
		run: () => {
			reset();
			const lonely = join(root, "lonely");
			mkdirSync(lonely, { recursive: true });
			const path = addNever(loadConfig(lonely), lonely, "new-rule", "local");
			return path === layerConfigPath(lonely) && readLayer(lonely).never?.includes("new-rule") === true;
		},
	},
	{
		name: "addNever targets the deepest existing layer",
		run: () => {
			reset();
			const path = addNever(loadConfig(nested), nested, "pkg-rule", "local");
			return path === layerConfigPath(pkg) && readLayer(pkg).never?.includes("pkg-rule") === true;
		},
	},
	{
		name: "--here writes the working directory even when a layer exists above",
		run: () => {
			reset();
			writeLayer(project, { never: ["root"] });
			const path = addNever(loadConfig(nested), nested, "here-rule", "local", true);
			return path === layerConfigPath(nested) && readLayer(nested).never?.includes("here-rule") === true;
		},
	},
	{
		name: "without --here the nearest existing layer wins",
		run: () => {
			reset();
			// Only the project layer exists, so that is where the rule belongs.
			rmSync(layerConfigPath(pkg));
			const path = addNever(loadConfig(nested), nested, "root-rule", "local");
			return path === layerConfigPath(project);
		},
	},
	{
		name: "addNever --global never touches a local layer",
		run: () => {
			reset();
			const path = addNever(loadConfig(nested), nested, "personal", "global");
			const global = JSON.parse(readFileSync(globalConfigPath(), "utf8")) as { never: string[] };
			return (
				path === globalConfigPath() &&
				global.never.includes("personal") &&
				(readLayer(pkg).never ?? []).includes("personal") === false
			);
		},
	},
	{
		name: "addNever preserves keys it does not own",
		run: () => {
			reset();
			writeLayer(pkg, { never: ["a"], model: "p/m" });
			addNever(loadConfig(nested), nested, "b", "local");
			const written = readLayer(pkg) as { never?: string[]; model?: string };
			return JSON.stringify(written.never) === JSON.stringify(["a", "b"]) && written.model === "p/m";
		},
	},
	{
		name: "removeNever edits the file that declares the rule",
		run: () => {
			reset();
			writeLayer(project, { never: ["root-rule"] });
			writeLayer(pkg, { never: ["pkg-rule"] });
			const path = removeNever(loadConfig(nested), "root-rule");
			return path === layerConfigPath(project) &&
				(readLayer(project).never ?? []).length === 0 &&
				JSON.stringify(readLayer(pkg).never) === JSON.stringify(["pkg-rule"]);
		},
	},
	{
		name: "a rule can carry explicit match terms",
		run: () => {
			reset();
			writeLayer(pkg, { never: [{ text: "不许改迁移", terms: ["数据库迁移", "迁移脚本"] }] });
			const rule = loadConfig(nested).rules[0];
			return rule?.text === "不许改迁移" && JSON.stringify(rule.terms) === JSON.stringify(["数据库迁移", "迁移脚本"]);
		},
	},
	{
		name: "adding an object keeps the plain strings around it",
		run: () => {
			reset();
			writeLayer(pkg, { never: ["plain"] });
			addNever(loadConfig(nested), nested, { text: "给了词的", terms: ["甲", "乙"] }, "local");
			const raw = JSON.parse(readFileSync(layerConfigPath(pkg), "utf8")) as { never: unknown[] };
			const shapes = raw.never.map((item) => (typeof item === "string" ? "string" : "object"));
			return JSON.stringify(shapes) === JSON.stringify(["string", "object"]);
		},
	},
	{
		name: "removing by text drops an object rule",
		run: () => {
			reset();
			writeLayer(pkg, { never: [{ text: "对象规则", terms: ["甲"] }, "普通规则"] });
			removeNever(loadConfig(nested), "对象规则");
			const raw = JSON.parse(readFileSync(layerConfigPath(pkg), "utf8")) as { never: unknown[] };
			return JSON.stringify(raw.never) === JSON.stringify(["普通规则"]);
		},
	},
	{
		name: "a broken layer file does not throw",
		run: () => {
			reset();
			mkdirSync(join(pkg, ".pi"), { recursive: true });
			writeFileSync(layerConfigPath(pkg), "{ not json");
			return Array.isArray(loadConfig(nested).never);
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
