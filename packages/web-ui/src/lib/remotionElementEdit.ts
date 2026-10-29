/**
 * Remotion MG element edit (lite) — peer of htmlMotionElementEdit.
 *
 * Source of truth is the same Canvas node override map
 * (`data.elementOverrides`: element id → `{ text?, x?, y? }` absolute values).
 * The Remotion TSX in `data.content` is the base/template component; rendering
 * applies overrides by passing `componentProps.mgElementOverrides` into
 * `RemotionSourceComposition` — we do **not** rewrite TSX on each keystroke.
 *
 * Admitted elements are JSX nodes in the TSX that declare `data-mg-id` +
 * `data-mg-editable` (same markers as HTML MG). Stable id scheme = the
 * `data-mg-id` attribute value (ID_RE / forbidden list shared with HTML).
 * Components read `props.mgElementOverrides?.[id]` for live text/x/y.
 *
 * Open-state SessionDraft mirrors HTML: local draft map; Canvas/Loro receive
 * overrides on checkpoint (pointerup, 500ms debounce, surface close).
 */

import {
  mergeElementOverride,
  normalizeElementOverrides,
  serializeElementOverrides,
  type MgEditableCapability,
  type MgEditableElement,
  type MgElementOverrides,
  type MgElementPatch,
} from "./htmlMotionElementEdit";

/** inputProps / componentProps key consumed by Remotion MG templates. */
export const MG_ELEMENT_OVERRIDES_PROP = "mgElementOverrides" as const;

const ID_RE = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/;
const FORBIDDEN_IDS = new Set(["constructor", "prototype", "__proto__"]);

export {
  mergeElementOverride,
  normalizeElementOverrides,
  serializeElementOverrides,
};
export type {
  MgEditableCapability,
  MgEditableElement,
  MgElementOverrides,
  MgElementPatch,
};

function parseEditableAttr(raw: string | null | undefined): MgEditableCapability[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(
      (v): v is MgEditableCapability =>
        v === "text" || v === "position" || v === "scale",
    );
}

function readAttr(tag: string, name: string): string | null {
  const re = new RegExp(
    `${name}\\s*=\\s*(?:\\{\\s*["']([^"']*)["']\\s*\\}|["']([^"']*)["']|\\{\\s*(-?\\d+(?:\\.\\d+)?)\\s*\\})`,
    "i",
  );
  const match = re.exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function readFiniteNumberAttr(tag: string, name: string): number | null {
  const raw = readAttr(tag, name);
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract the opening JSX/HTML tag that contains `data-mg-id` at attrIndex.
 * Best-effort scanner — enough for Clash Remotion templates + Agent-authored
 * markers; not a full TSX parser.
 */
function openingTagContaining(
  source: string,
  attrIndex: number,
): { tag: string; start: number; end: number } | null {
  let start = attrIndex;
  while (start > 0 && source[start] !== "<") start -= 1;
  if (source[start] !== "<") return null;
  let i = start + 1;
  let quote: '"' | "'" | null = null;
  let brace = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "{") {
      brace += 1;
      i += 1;
      continue;
    }
    if (ch === "}" && brace > 0) {
      brace -= 1;
      i += 1;
      continue;
    }
    if (brace === 0 && ch === ">") {
      return { tag: source.slice(start, i + 1), start, end: i + 1 };
    }
    i += 1;
  }
  return null;
}

function readDefaultText(source: string, tagEnd: number, tag: string): string {
  const fromAttr =
    readAttr(tag, "data-mg-default-text") ?? readAttr(tag, "data-mg-text");
  if (fromAttr != null) return fromAttr;
  const after = source.slice(tagEnd);
  const child = /^([^<{]+)/.exec(after);
  if (child) return child[1]!.trim();
  return "";
}

function readPosition(tag: string, axis: "x" | "y"): number {
  const primary = readFiniteNumberAttr(tag, `data-mg-${axis}`);
  if (primary != null) return primary;
  const fallback = readFiniteNumberAttr(tag, `data-mg-default-${axis}`);
  return fallback ?? 0;
}

/** Admit unique `data-mg-id` JSX nodes that declare at least one editable capability. */
export function listRemotionEditableElements(source: string): MgEditableElement[] {
  if (!source || typeof source !== "string") return [];
  const idAttrRe =
    /data-mg-id\s*=\s*(?:\{\s*["']([^"']+)["']\s*\}|["']([^"']+)["'])/g;
  const seen = new Set<string>();
  const result: MgEditableElement[] = [];
  let match: RegExpExecArray | null;
  while ((match = idAttrRe.exec(source)) !== null) {
    const id = match[1] ?? match[2] ?? "";
    const opened = openingTagContaining(source, match.index);
    if (!opened) continue;
    if (seen.has(id)) {
      const idx = result.findIndex((item) => item.id === id);
      if (idx >= 0) result.splice(idx, 1);
      continue;
    }
    seen.add(id);
    if (!ID_RE.test(id) || FORBIDDEN_IDS.has(id)) continue;
    const editable = parseEditableAttr(readAttr(opened.tag, "data-mg-editable"));
    if (!editable.length) continue;
    const param = readAttr(opened.tag, "data-mg-param") ?? undefined;
    result.push({
      id,
      editable,
      text: readDefaultText(source, opened.end, opened.tag),
      x: readPosition(opened.tag, "x"),
      y: readPosition(opened.tag, "y"),
      ...(param ? { param } : {}),
    });
  }
  return result;
}

export function listRemotionEditableElementsWithOverrides(
  source: string,
  overrides: MgElementOverrides,
): MgEditableElement[] {
  const listed = listRemotionEditableElements(source);
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

/** Seed missing override entries from TSX-admitted defaults (migrate / first edit). */
export function seedElementOverridesFromRemotionSource(
  source: string,
  overrides: MgElementOverrides,
  elementIds?: string[],
): MgElementOverrides {
  const listed = listRemotionEditableElements(source);
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

/** Build RemotionSourceComposition componentProps from the override map. */
export function buildRemotionMgComponentProps(
  overrides: MgElementOverrides | undefined,
): Record<string, unknown> {
  return {
    [MG_ELEMENT_OVERRIDES_PROP]: normalizeElementOverrides(overrides),
  };
}

/**
 * Resolve componentProps for a remotion-component node: elementOverrides →
 * `{ mgElementOverrides }`. Empty map when no overrides (template defaults).
 */
export function resolveRemotionMgComponentProps(
  data: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return buildRemotionMgComponentProps(
    normalizeElementOverrides(data?.elementOverrides),
  );
}
