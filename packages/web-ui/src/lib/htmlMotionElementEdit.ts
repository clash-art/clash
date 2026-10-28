/**
 * Hilo-homage HTML MG element edit (lite).
 *
 * Source of truth for element text/position is an **override map** on the
 * html-motion Canvas node (`data.elementOverrides`: `data-mg-id` →
 * `{ text?, x?, y? }`). The HTML `content` string is the base/template
 * document; rendering derives HTML by applying overrides onto admitted
 * `[data-mg-id]` nodes. Checkpoints may also write derived HTML back to
 * `content` so non-open consumers (preview cards, Agent, export) see updates
 * without re-deriving — overrides store absolute values so re-apply is
 * idempotent.
 *
 * Open-state SessionDraft (lite): inspector/stage mutate a local draft map;
 * Canvas/Loro receive overrides (+ derived content) only on checkpoint
 * (pointerup, debounce/blur pause, surface close) — match text autosave
 * cadence, not per-keystroke full-HTML SoT.
 *
 * Position uses parent-local CSS-pixel values on `data-mg-x` / `data-mg-y` and a
 * matching `translate(xpx, ypx)` in the element's inline style — not a full
 * SessionDraft / live-edit bus / OSR path / char-level CRDT.
 */

export type MgEditableCapability = "text" | "position" | "scale";

export type MgEditableElement = {
  id: string;
  editable: MgEditableCapability[];
  text: string;
  x: number;
  y: number;
  param?: string;
};

/** Absolute element patch / override entry (partial fields allowed). */
export type MgElementPatch = {
  text?: string;
  x?: number;
  y?: number;
};

/**
 * Authoritative per-element override map on html-motion node data.
 * Keys are `data-mg-id` values. Values are absolute text/x/y — not deltas.
 */
export type MgElementOverrides = Record<string, MgElementPatch>;

const ID_RE = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/;
const FORBIDDEN_IDS = new Set(["constructor", "prototype", "__proto__"]);

function parseEditableAttr(raw: string | null): MgEditableCapability[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(
      (v): v is MgEditableCapability =>
        v === "text" || v === "position" || v === "scale",
    );
}

function readNumberAttr(node: Element, name: string): number {
  const raw = node.getAttribute(name);
  if (raw == null || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function parseTranslate(style: string): { x: number; y: number } | null {
  const match = /translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/.exec(style);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function setTranslateStyle(node: Element, x: number, y: number): void {
  const style = node.getAttribute("style") ?? "";
  const nextTranslate = `translate(${x}px, ${y}px)`;
  let nextStyle: string;
  if (/translate\([^)]*\)/.test(style)) {
    nextStyle = style.replace(/translate\([^)]*\)/, nextTranslate);
  } else if (style.trim()) {
    const trimmed = style.trim().replace(/;?\s*$/, "");
    nextStyle = `${trimmed}; transform: ${nextTranslate};`;
  } else {
    nextStyle = `transform: ${nextTranslate};`;
  }
  node.setAttribute("style", nextStyle);
  node.setAttribute("data-mg-x", String(x));
  node.setAttribute("data-mg-y", String(y));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizePatch(raw: unknown): MgElementPatch | null {
  if (!isPlainObject(raw)) return null;
  const next: MgElementPatch = {};
  if (raw.text !== undefined) {
    if (typeof raw.text !== "string" || raw.text.length > 8192) return null;
    next.text = raw.text;
  }
  if (raw.x !== undefined) {
    if (
      typeof raw.x !== "number" ||
      !Number.isFinite(raw.x) ||
      Math.abs(raw.x) > 1_000_000
    ) {
      return null;
    }
    next.x = raw.x;
  }
  if (raw.y !== undefined) {
    if (
      typeof raw.y !== "number" ||
      !Number.isFinite(raw.y) ||
      Math.abs(raw.y) > 1_000_000
    ) {
      return null;
    }
    next.y = raw.y;
  }
  if (
    next.text === undefined &&
    next.x === undefined &&
    next.y === undefined
  ) {
    return null;
  }
  return next;
}

/** Normalize unknown node-data payload into a safe override map. */
export function normalizeElementOverrides(raw: unknown): MgElementOverrides {
  if (!isPlainObject(raw)) return {};
  const out: MgElementOverrides = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!ID_RE.test(id) || FORBIDDEN_IDS.has(id)) continue;
    const patch = sanitizePatch(value);
    if (!patch) continue;
    out[id] = patch;
  }
  return out;
}

/** Stable JSON fingerprint for draft-vs-persisted equality checks. */
export function serializeElementOverrides(
  overrides: MgElementOverrides,
): string {
  const ids = Object.keys(overrides).sort();
  const normalized: MgElementOverrides = {};
  for (const id of ids) {
    const entry = overrides[id];
    if (!entry) continue;
    const next: MgElementPatch = {};
    if (entry.text !== undefined) next.text = entry.text;
    if (entry.x !== undefined) next.x = entry.x;
    if (entry.y !== undefined) next.y = entry.y;
    if (
      next.text === undefined &&
      next.x === undefined &&
      next.y === undefined
    ) {
      continue;
    }
    normalized[id] = next;
  }
  return JSON.stringify(normalized);
}

/** Merge a partial patch into one element's override entry (absolute fields). */
export function mergeElementOverride(
  overrides: MgElementOverrides,
  elementId: string,
  patch: MgElementPatch,
): MgElementOverrides {
  if (!ID_RE.test(elementId) || FORBIDDEN_IDS.has(elementId)) {
    throw new Error("HTML_MOTION_INVALID_ELEMENT");
  }
  if (
    patch &&
    typeof patch === "object" &&
    Object.values(patch).some((value) => value === undefined)
  ) {
    throw new Error("HTML_MOTION_INVALID_ELEMENT_PATCH");
  }
  const sanitized = sanitizePatch(patch);
  if (!sanitized) {
    throw new Error("HTML_MOTION_INVALID_ELEMENT_PATCH");
  }
  const prev = overrides[elementId] ?? {};
  return {
    ...overrides,
    [elementId]: { ...prev, ...sanitized },
  };
}

/**
 * Seed missing override entries from current HTML attributes/text for the
 * given ids (migrate path / first edit). Existing override keys are kept.
 */
export function seedElementOverridesFromHtml(
  html: string,
  overrides: MgElementOverrides,
  elementIds?: string[],
): MgElementOverrides {
  const listed = listHtmlMotionEditableElements(html);
  const want =
    elementIds && elementIds.length > 0
      ? new Set(elementIds)
      : new Set(listed.map((item) => item.id));
  let next = overrides;
  let changed = false;
  for (const el of listed) {
    if (!want.has(el.id)) continue;
    if (overrides[el.id]) continue;
    next = {
      ...next,
      [el.id]: { text: el.text, x: el.x, y: el.y },
    };
    changed = true;
  }
  return changed ? next : overrides;
}

/** Admit unique `[data-mg-id]` nodes that declare at least one editable capability. */
export function listHtmlMotionEditableElements(
  html: string,
): MgEditableElement[] {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const nodes = [...doc.querySelectorAll("[data-mg-id]")];
  const seen = new Set<string>();
  const result: MgEditableElement[] = [];

  for (const node of nodes) {
    const id = node.getAttribute("data-mg-id") ?? "";
    if (seen.has(id)) {
      const idx = result.findIndex((item) => item.id === id);
      if (idx >= 0) result.splice(idx, 1);
      continue;
    }
    seen.add(id);
    if (!ID_RE.test(id) || FORBIDDEN_IDS.has(id)) continue;
    const editable = parseEditableAttr(node.getAttribute("data-mg-editable"));
    if (!editable.length) continue;
    const param = node.getAttribute("data-mg-param") ?? undefined;
    const fromAttrX = readNumberAttr(node, "data-mg-x");
    const fromAttrY = readNumberAttr(node, "data-mg-y");
    const fromStyle = parseTranslate(node.getAttribute("style") ?? "");
    result.push({
      id,
      editable,
      text: (node.textContent ?? "").trim(),
      x: node.hasAttribute("data-mg-x") ? fromAttrX : (fromStyle?.x ?? 0),
      y: node.hasAttribute("data-mg-y") ? fromAttrY : (fromStyle?.y ?? 0),
      ...(param ? { param } : {}),
    });
  }
  return result;
}

/**
 * List admitted elements with override map applied (inspector SessionDraft view).
 * Nodes without overrides behave as today (values from HTML).
 */
export function listHtmlMotionEditableElementsWithOverrides(
  html: string,
  overrides: MgElementOverrides,
): MgEditableElement[] {
  const listed = listHtmlMotionEditableElements(html);
  if (!overrides || Object.keys(overrides).length === 0) return listed;
  return listed.map((el) => {
    const patch = overrides[el.id];
    if (!patch) return el;
    return {
      ...el,
      text: patch.text !== undefined ? patch.text : el.text,
      x: patch.x !== undefined ? patch.x : el.x,
      y: patch.y !== undefined ? patch.y : el.y,
    };
  });
}

/**
 * Apply a text / position patch to one admitted element and return the new HTML.
 * Throws typed errors mirroring Hilo's pure edit boundary names.
 */
export function applyHtmlMotionElementPatch(
  html: string,
  elementId: string,
  patch: MgElementPatch,
): string {
  if (typeof DOMParser === "undefined") {
    throw new Error("HTML_MOTION_INVALID_ELEMENT");
  }
  if (!ID_RE.test(elementId) || FORBIDDEN_IDS.has(elementId)) {
    throw new Error("HTML_MOTION_INVALID_ELEMENT");
  }
  if (
    patch &&
    typeof patch === "object" &&
    Object.values(patch).some((value) => value === undefined)
  ) {
    throw new Error("HTML_MOTION_INVALID_ELEMENT_PATCH");
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const matches = [...doc.querySelectorAll("[data-mg-id]")].filter(
    (node) => node.getAttribute("data-mg-id") === elementId,
  );
  if (matches.length !== 1) {
    throw new Error("HTML_MOTION_INVALID_ELEMENT");
  }
  const node = matches[0]!;
  const editable = parseEditableAttr(node.getAttribute("data-mg-editable"));
  if (!editable.length) {
    throw new Error("HTML_MOTION_ELEMENT_NOT_EDITABLE");
  }

  if (patch.text !== undefined) {
    if (!editable.includes("text")) {
      throw new Error("HTML_MOTION_ELEMENT_NOT_EDITABLE");
    }
    if (typeof patch.text !== "string" || patch.text.length > 8192) {
      throw new Error("HTML_MOTION_INVALID_ELEMENT_PATCH");
    }
    node.textContent = patch.text;
  }

  if (patch.x !== undefined || patch.y !== undefined) {
    if (!editable.includes("position")) {
      throw new Error("HTML_MOTION_ELEMENT_NOT_EDITABLE");
    }
    const currentX = readNumberAttr(node, "data-mg-x");
    const currentY = readNumberAttr(node, "data-mg-y");
    const nextX = patch.x !== undefined ? patch.x : currentX;
    const nextY = patch.y !== undefined ? patch.y : currentY;
    if (
      !Number.isFinite(nextX) ||
      !Number.isFinite(nextY) ||
      Math.abs(nextX) > 1_000_000 ||
      Math.abs(nextY) > 1_000_000
    ) {
      throw new Error("HTML_MOTION_INVALID_ELEMENT_PATCH");
    }
    setTranslateStyle(node, nextX, nextY);
  }

  // Prefer serializing the full document when the input looked like one.
  const hasHtmlTag = /<html[\s>]/i.test(html);
  if (hasHtmlTag && doc.documentElement) {
    const doctype = html.trimStart().toLowerCase().startsWith("<!doctype")
      ? "<!doctype html>\n"
      : "";
    return `${doctype}${doc.documentElement.outerHTML}`;
  }
  return doc.body?.innerHTML ?? html;
}

/**
 * Derive HTML by applying the override map onto the base/template document.
 * Absolute overrides make re-apply on already-derived content idempotent.
 */
export function deriveHtmlMotionContent(
  baseHtml: string,
  overrides: MgElementOverrides,
): string {
  const normalized = normalizeElementOverrides(overrides);
  const ids = Object.keys(normalized);
  if (ids.length === 0) return baseHtml;
  let next = baseHtml;
  for (const id of ids) {
    const patch = normalized[id];
    if (!patch) continue;
    try {
      next = applyHtmlMotionElementPatch(next, id, patch);
    } catch {
      // Skip unknown / non-editable ids — migrate-tolerant.
    }
  }
  return next;
}

/**
 * Resolve display/export HTML for an html-motion node: base `content` +
 * `elementOverrides`. When overrides are absent, returns content as today.
 */
export function resolveHtmlMotionNodeContent(
  data: Record<string, unknown> | null | undefined,
  fallbackHtml = "",
): string {
  const content =
    typeof data?.content === "string" && data.content.trim()
      ? data.content
      : fallbackHtml;
  const overrides = normalizeElementOverrides(data?.elementOverrides);
  return deriveHtmlMotionContent(content, overrides);
}
