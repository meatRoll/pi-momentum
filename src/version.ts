/**
 * Extension version, printed by `/momentum` so a running process can be told
 * apart from a published snapshot. Pi materialises a snapshot per publish and a
 * running process keeps the one it started with; without this, "did I restart?"
 * is guesswork.
 *
 * Kept as a literal rather than read from package.json: the module may be loaded
 * through a transform, and file-relative reads are the fragile part of that.
 * test/version.ts fails if this drifts from package.json.
 */
export const VERSION = "1.4.0";
