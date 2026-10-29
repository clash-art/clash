/**
 * Shared MG element inspector (Hilo MotionElementInspector lite).
 *
 * Elements list + Text/X/Y fields used by both the fullscreen MgOpenSurface and
 * the Project Timeline in-place composition inspector. The parent owns the
 * SessionDraft; this component only renders admitted elements and emits patches.
 */
import {
  type MgEditableElement,
  type MgElementPatch,
} from "../lib/htmlMotionElementEdit";
import { Input } from "./ui/input";

export type MgElementInspectorTestIdPrefix = "mg-element" | "mg-open-element";

export function MgElementInspector({
  elements,
  selectedId,
  onSelect,
  onPatch,
  testIdPrefix = "mg-element",
}: {
  elements: MgEditableElement[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPatch: (elementId: string, patch: MgElementPatch) => void;
  /** Keep the legacy fullscreen test ids while sharing the component. */
  testIdPrefix?: MgElementInspectorTestIdPrefix;
}) {
  const selected =
    elements.find((item) => item.id === selectedId) ?? elements[0] ?? null;

  if (!elements.length) {
    return (
      <div
        data-testid={`${testIdPrefix}-inspector-empty`}
        className="space-y-1 border-t border-warm-border pt-4"
      >
        <p className="text-xs font-medium text-content-secondary">Elements</p>
        <p className="text-xs leading-relaxed text-content-muted">
          No editable elements. Author{" "}
          <code className="text-[10px]">data-mg-id</code> +{" "}
          <code className="text-[10px]">
            data-mg-editable=&quot;text,position&quot;
          </code>{" "}
          on HTML nodes or Remotion JSX (default create templates include one).
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid={`${testIdPrefix}-inspector`}
      className="space-y-3 border-t border-warm-border pt-4"
      aria-label="Motion element inspector"
    >
      <p className="text-xs font-medium text-content-secondary">Elements</p>
      <ul className="space-y-1" data-testid={`${testIdPrefix}-list`}>
        {elements.map((el) => (
          <li key={el.id}>
            <button
              type="button"
              data-testid={`${testIdPrefix}-${el.id}`}
              aria-pressed={selected?.id === el.id}
              className={`w-full truncate rounded px-2 py-1.5 text-left text-xs ${
                selected?.id === el.id
                  ? "bg-warm-hover text-content-primary"
                  : "text-content-secondary hover:bg-warm-hover/60"
              }`}
              onClick={() => onSelect(el.id)}
            >
              {el.id}
            </button>
          </li>
        ))}
      </ul>

      {selected ? (
        <div className="space-y-3" data-testid={`${testIdPrefix}-fields`}>
          <p className="truncate text-xs text-content-muted">{selected.id}</p>
          {selected.editable.includes("text") ? (
            <label className="block space-y-1 text-xs text-content-secondary">
              <span>Text</span>
              <Input
                data-testid={`${testIdPrefix}-text`}
                aria-label="Element text"
                value={selected.text}
                maxLength={8192}
                onChange={(event) =>
                  onPatch(selected.id, { text: event.target.value })
                }
              />
            </label>
          ) : null}
          {selected.editable.includes("position") ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1 text-xs text-content-secondary">
                <span>X</span>
                <Input
                  data-testid={`${testIdPrefix}-x`}
                  aria-label="Element X"
                  type="number"
                  step={1}
                  value={String(Math.round(selected.x * 100) / 100)}
                  onChange={(event) => {
                    const n = Number(event.target.value);
                    if (!Number.isFinite(n)) return;
                    onPatch(selected.id, { x: n });
                  }}
                />
              </label>
              <label className="block space-y-1 text-xs text-content-secondary">
                <span>Y</span>
                <Input
                  data-testid={`${testIdPrefix}-y`}
                  aria-label="Element Y"
                  type="number"
                  step={1}
                  value={String(Math.round(selected.y * 100) / 100)}
                  onChange={(event) => {
                    const n = Number(event.target.value);
                    if (!Number.isFinite(n)) return;
                    onPatch(selected.id, { y: n });
                  }}
                />
              </label>
            </div>
          ) : null}
          <p className="text-[11px] leading-relaxed text-content-muted">
            Drag on stage to move position; double-click text on stage to edit.
            Draft overrides flush to Canvas on pause / drag end / close.
          </p>
        </div>
      ) : null}
    </div>
  );
}
