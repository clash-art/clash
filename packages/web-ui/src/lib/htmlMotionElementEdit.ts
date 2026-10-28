/**
 * Hilo-homage HTML MG element edit (lite).
 *
 * Parses `[data-mg-id]` + `data-mg-editable` (text / position / scale) the same
 * way Hilo TimelineMotionNativeSurface / MotionElementInspector admit targets,
 * then mutates the HTML document string (Clash Canvas node `content` SoT).
 *
 * Position uses parent-local CSS-pixel deltas on `data-mg-x` / `data-mg-y` and a
 * matching `translate(xpx, ypx)` in the element's inline style — not a full
 * SessionDraft / live-edit bus / OSR path.
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

export type MgElementPatch = {
  text?: string;
  x?: number;
  y?: number;
};

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
