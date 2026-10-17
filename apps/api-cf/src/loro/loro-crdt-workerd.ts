/**
 * Worker bundle target of the bare `loro-crdt` specifier (wrangler.toml
 * `[alias]`).
 *
 * loro's `bundler` entry instantiates its wasm with a top-level `await`.
 * Once a module graph containing it is loaded through `import()` (lazy Durable
 * Objects and routes, #161), esbuild turns every importer's init into an async
 * function, and an import cycle between two such modules never settles: the
 * request hangs. The wasm-bindgen `web` entry is the same API without
 * top-level await; ./loro-crdt-workerd-init.ts instantiates it synchronously
 * before loro's index evaluates.
 *
 * Paths are relative because the `loro-crdt` alias would also rewrite
 * `loro-crdt/web`.
 */
import "./loro-crdt-workerd-init";

export * from "../../node_modules/loro-crdt/web/index.js";
