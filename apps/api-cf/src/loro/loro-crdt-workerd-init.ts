/**
 * Instantiates loro's wasm synchronously from the precompiled module that the
 * Worker bundle's CompiledWasm rule provides. Evaluated before loro's index
 * (see ./loro-crdt-workerd.ts). Instantiating a precompiled module is allowed
 * in workerd; only runtime compilation from bytes is not.
 */
import { initSync } from "../../node_modules/loro-crdt/web/loro_wasm.js";
// CompiledWasm rule (wrangler.toml): the default export is a WebAssembly.Module.
import loroWasmModule from "../../node_modules/loro-crdt/web/loro_wasm_bg.wasm";

initSync({ module: loroWasmModule as WebAssembly.Module });
