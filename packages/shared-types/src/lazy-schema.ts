/**
 * @file lazy-schema.ts
 * @description Defers construction of a Zod schema (or another product value) until its first use.
 *
 * The Host bundles every exported product schema into one synchronous CommonJS evaluation. At
 * startup the packaged Host built ~10,000 zod schemas from this package but only used ~322 of them
 * before `/health`, so most of that work was paid for a request that never arrived. A lazy value is
 * a transparent proxy: the initializer runs exactly once, on the first property read, and every
 * later read goes to the same object. A failed initializer is not remembered; the same throw is
 * raised to the caller, so a malformed model catalog still fails loudly on first use.
 */

import { z } from "zod";

const initializedValues = new WeakSet<object>();
/** Every proxy created by `lazyValue`; used to recognize a lazy reference without initializing it. */
const lazyProxies = new WeakSet<object>();
/** proxy -> real value once the initializer has run. */
const initializedRealValues = new WeakMap<object, object>();
/** Places a (still uninitialized) schema proxy was seen in a constructed def tree. */
const pendingReferences = new WeakMap<object, LazyReference[]>();
let constructionCount = 0;

type LazyReference = {
  container: object;
  key: string | number;
};

/** Test/diagnostic probe: true once `value`'s initializer has run. */
export function isLazyValueInitialized(value: object): boolean {
  return initializedValues.has(value);
}

/** Test/diagnostic probe: how many lazy values have been constructed in this module instance. */
export function lazyValueConstructionCount(): number {
  return constructionCount;
}

/**
 * Wrap `init` in a transparent proxy so it is evaluated on first use rather than at module scope.
 *
 * `target` is the proxy's [[Target]]. The default `{}` is enough for zod schemas; array values
 * pass `[]` so `Array.isArray` keeps answering true. The target is not the initializer's result,
 * so every operation is forwarded to that result by the handlers below.
 */
export function lazyValue<T extends object>(
  init: () => T,
  target: object = {},
  onInitialized?: (value: T, proxy: T) => void,
): T {
  let done = false;
  let value: T | undefined;
  let boundFunctions: Map<PropertyKey, unknown> | undefined;

  const ensure = (): T => {
    if (!done) {
      // Assign only after init returns: a throw leaves the value uninitialized so the caller sees
      // the real error (including zod's issue tree) instead of a half-built proxy.
      const next = init();
      value = next;
      done = true;
      constructionCount += 1;
      initializedValues.add(proxy);
      lazyProxies.add(proxy);
      onInitialized?.(next, proxy as T);
    }
    return value as T;
  };

  const proxy = new Proxy(target, {
    get(_target, property) {
      const real = ensure();
      const result = Reflect.get(real, property);
      if (typeof result !== "function" || property === "constructor") return result;
      // Bind methods to the real object. Without this, `lazy.parse(...)` runs the real `parse`
      // with `this === proxy`, so every internal `this._zod` read pays a trap; that is the hot
      // path for every direct parse of an exported schema.
      boundFunctions ??= new Map();
      const cached = boundFunctions.get(property);
      if (cached !== undefined) return cached;
      const bound = result.bind(real);
      boundFunctions.set(property, bound);
      return bound;
    },
    set(_target, property, next) {
      return Reflect.set(ensure(), property, next);
    },
    has(_target, property) {
      return Reflect.has(ensure(), property);
    },
    ownKeys() {
      return Reflect.ownKeys(ensure());
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(ensure(), property);
      if (!descriptor) return undefined;
      // The proxy target never owns `_zod` (or any other non-configurable schema property), while
      // the real schema does. A non-configurable descriptor that is absent from the target would
      // violate the proxy invariants, so report it as configurable when forwarding.
      if (!descriptor.configurable && !Reflect.getOwnPropertyDescriptor(target, property)) {
        return { ...descriptor, configurable: true };
      }
      return descriptor;
    },
    defineProperty(_target, property, descriptor) {
      return Reflect.defineProperty(ensure(), property, descriptor);
    },
    deleteProperty(_target, property) {
      return Reflect.deleteProperty(ensure(), property);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(ensure());
    },
    setPrototypeOf(_target, proto) {
      return Reflect.setPrototypeOf(ensure(), proto);
    },
    isExtensible() {
      return Reflect.isExtensible(ensure());
    },
    preventExtensions() {
      return Reflect.preventExtensions(ensure());
    },
  });

  lazyProxies.add(proxy);
  return proxy as T;
}

/**
 * Make zod's identity-keyed operations see the exported proxy consistently.
 *
 * Zod stores two things by schema object identity: the metadata registry (`.describe()` /
 * `.meta()`) and the per-conversion `seen` map in `z.toJSONSchema`. A schema built inside an
 * initializer registered its description against the real object, and zod's per-class
 * `_zod.processJSONSchema` closes over that real object, so a nested proxy would look up the
 * proxy in `seen` and miss (or throw). Clearing the bound emitter makes zod use its generic
 * processor table, which receives the schema object that actually reached it (the proxy), and
 * copying the real metadata onto the proxy keeps the registry lookup aligned.
 */
function adoptZodSchemaIdentity(real: object, proxy: object): void {
  const internals = (real as { _zod?: { processJSONSchema?: unknown } })._zod;
  if (!internals || typeof internals !== "object") return;

  // A schema that was constructed with another exported schema gets the proxy in its def tree.
  // Swap every such reference to the real schema as soon as it exists, so parse and JSON Schema
  // generation see ordinary zod objects and V8 can keep the hot path monomorphic.
  initializedRealValues.set(proxy, real);
  flushPendingReferences(proxy, real);
  registerPendingReferences(real);

  if (typeof internals.processJSONSchema === "function") {
    // Clear rather than `delete`: a deleted property changes the `_zod` hidden class and slows
    // every parse through the object. `undefined` makes zod take its generic processor path.
    internals.processJSONSchema = undefined;
  }
  const metadata = z.globalRegistry.get(real as z.core.$ZodType);
  if (metadata) z.globalRegistry.add(proxy as z.core.$ZodType, metadata);
}

const SINGLE_SCHEMA_SLOTS = [
  "element",
  "innerType",
  "keyType",
  "valueType",
  "left",
  "right",
  "in",
  "out",
  "catchall",
  "rest",
  "parent",
] as const;
const SCHEMA_ARRAY_SLOTS = ["options", "items"] as const;
const SCHEMA_SHAPE_SLOTS = ["shape"] as const;

function isRealSchema(value: unknown): value is { _zod: { def: { type?: unknown } } } {
  if (!value || typeof value !== "object" || lazyProxies.has(value)) return false;
  const internals = (value as { _zod?: { def?: { type?: unknown } } })._zod;
  return !!internals?.def && typeof internals.def.type === "string";
}

function containerValue(container: object, key: string | number): unknown {
  return (container as Record<string | number, unknown>)[key];
}

function setContainerValue(container: object, key: string | number, value: unknown): void {
  (container as Record<string | number, unknown>)[key] = value;
}

function rememberReference(
  reference: object,
  container: LazyReference["container"],
  key: string | number,
): void {
  const list = pendingReferences.get(reference) ?? [];
  list.push({ container, key });
  pendingReferences.set(reference, list);
  const real = initializedRealValues.get(reference);
  if (real !== undefined && containerValue(container, key) === reference) {
    setContainerValue(container, key, real);
  }
}

function flushPendingReferences(proxy: object, real: object): void {
  const list = pendingReferences.get(proxy);
  if (!list) return;
  for (const { container, key } of list) {
    if (containerValue(container, key) === proxy) setContainerValue(container, key, real);
  }
  pendingReferences.delete(proxy);
}

/**
 * Walk a constructed schema's def tree and remember (or immediately replace) every slot that
 * still holds an uninitialized lazy proxy. Proxies are recognized by identity and never touched,
 * so discovery does not force the rest of the lazy graph to construct.
 */
function registerPendingReferences(root: object): void {
  const visited = new WeakSet<object>();

  const visit = (schema: object): void => {
    if (visited.has(schema)) return;
    visited.add(schema);
    const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (!def) return;

    for (const slot of SINGLE_SCHEMA_SLOTS) {
      if (!(slot in def)) continue;
      const child = def[slot];
      if (lazyProxies.has(child as object)) rememberReference(child as object, def, slot);
      else if (isRealSchema(child)) visit(child);
    }
    for (const slot of SCHEMA_ARRAY_SLOTS) {
      const children = def[slot];
      if (!Array.isArray(children)) continue;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (lazyProxies.has(child as object)) rememberReference(child as object, children, index);
        else if (isRealSchema(child)) visit(child);
      }
    }
    for (const slot of SCHEMA_SHAPE_SLOTS) {
      const shape = def[slot];
      if (!shape || typeof shape !== "object" || Array.isArray(shape)) continue;
      const record = shape as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const child = record[key];
        if (lazyProxies.has(child as object)) rememberReference(child as object, record, key);
        else if (isRealSchema(child)) visit(child);
      }
    }
  };

  visit(root);
}

/**
 * `lazyValue` for a zod schema, with the schema's own type preserved for `z.infer`.
 *
 * `swap` receives the real schema once it exists. Callers pass `(real) => { Export = real; }`
 * so the module's live binding stops yielding the proxy after first use; that keeps hot parse
 * call sites out of the proxy trap entirely.
 */
export function lazySchema<T extends object>(
  init: () => T,
  swap?: (real: T) => void,
): T {
  return lazyValue(init, {}, (real, proxy) => {
    adoptZodSchemaIdentity(real, proxy);
    swap?.(real);
  });
}
