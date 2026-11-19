/**
 * Version drift check.
 *
 * `VERSION` is what a running process prints, `package.json` is what a snapshot
 * ships. If they disagree, "did I restart?" answers get wrong.
 */

import { readFileSync } from "node:fs";
import { VERSION } from "../src/version.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	version: string;
};

const ok = pkg.version === VERSION;
console.log(
	`${ok ? "ok  " : "FAIL"}  version.ts (${VERSION}) matches package.json (${pkg.version})`,
);
if (!ok) {
	console.error("\nversion mismatch");
	process.exit(1);
}
