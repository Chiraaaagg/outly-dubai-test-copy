/**
 * Target guard for scripts (seed, purge, drills, sync, db wrapper). One
 * implementation, shared with the test suites: see
 * src/server/__tests__/helpers/target-guard.ts for the rules.
 *
 * tsx scripts import this file; plain .mjs scripts import the source module
 * directly with its .ts extension (Node strips the types).
 */
export * from "../../src/server/__tests__/helpers/target-guard";
