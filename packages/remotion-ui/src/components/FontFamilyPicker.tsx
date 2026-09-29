import React, { useState } from "react";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxProvider,
  useComboboxStore,
} from "@clash/gui/components/ui/combobox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@clash/gui/components/ui/popover";
import { RemotionButton } from "./ui/controls";

type FontAccessWindow = Window & {
  queryLocalFonts?: () => Promise<Array<{ family: string }>>;
};

const genericFamilies = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

/** Local Font Access is invoked by opening the picker, preserving user activation. */
export function FontFamilyPicker({
  value,
  onChange,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (family: string) => void;
  ariaLabel: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [families, setFamilies] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const store = useComboboxStore({
    value: query,
    setValue: setQuery,
    focusLoop: true,
    focusWrap: true,
    setSelectedValue: (family) => {
      if (typeof family === "string") {
        onChange(family);
        setOpen(false);
      }
    },
  });
  const loadFonts = async () => {
    const api = window as FontAccessWindow;
    if (!api.queryLocalFonts) {
      setStatus(
        "This browser cannot list local fonts. Open this project in Clash Desktop to choose installed fonts.",
      );
      return;
    }
    setLoading(true);
    setStatus("");
    try {
      const fonts = await api.queryLocalFonts();
      const names = [
        ...new Set(fonts.map((font) => font.family).filter(Boolean)),
      ].sort((a, b) => a.localeCompare(b));
      setFamilies(names);
      if (!names.length)
        setStatus(
          "No local fonts were returned. Check font access and try again.",
        );
    } catch {
      setStatus("Could not read local fonts. Allow font access, then retry.");
    } finally {
      setLoading(false);
    }
  };
  const options = [...new Set([value, ...families])].filter((family) =>
    family.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const requestedFamily = value
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
  const normalizedFamily = requestedFamily.toLocaleLowerCase();
  const missingFamily =
    !loading &&
    !status &&
    families.length > 0 &&
    !genericFamilies.has(normalizedFamily) &&
    !families.some((family) => family.toLocaleLowerCase() === normalizedFamily);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          void loadFonts();
        }
      }}
    >
      <PopoverTrigger asChild>
        <RemotionButton
          aria-label={ariaLabel}
          className={`${className ?? ""} flex items-center justify-between gap-2 text-left`}
        >
          <span className="truncate">{value}</span>
          <span aria-hidden="true">⌄</span>
        </RemotionButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-24px)]">
        <ComboboxProvider store={store}>
          <Combobox
            autoFocus
            autoSelect
            aria-label="Search installed fonts"
            placeholder="Search installed fonts…"
            className="h-9 w-full rounded-lg border border-warm-border bg-warm-surface px-3 outline-none focus:ring-2 focus:ring-ring/30"
          />
          <ComboboxList
            alwaysVisible
            aria-label="Installed fonts"
            className="max-h-64 overflow-y-auto overscroll-contain"
          >
            {options.map((family) => (
              <ComboboxItem
                key={family}
                value={family}
                setValueOnClick={false}
                focusOnHover
                aria-label={family}
                className="block w-full cursor-default rounded-md px-3 py-2 text-left text-sm outline-none hover:bg-warm-hover data-[active-item]:bg-warm-hover"
              >
                <span style={{ fontFamily: family }}>{family}</span>
                {family === value && (
                  <span aria-hidden="true" className="float-right">
                    ✓
                  </span>
                )}
              </ComboboxItem>
            ))}
            {!options.length && !loading && (
              <p className="px-3 text-sm text-stone-500">No matching fonts</p>
            )}
          </ComboboxList>
        </ComboboxProvider>
        {loading && (
          <p role="status" className="text-xs text-stone-500">
            Reading installed fonts…
          </p>
        )}
        {status && (
          <div role="status" className="text-xs text-stone-500">
            {status}
            <RemotionButton
              onClick={() => void loadFonts()}
              className="ml-2 underline"
            >
              Retry
            </RemotionButton>
          </div>
        )}
        {missingFamily && (
          <p
            role="status"
            className="text-xs text-amber-700 dark:text-amber-400"
          >
            {requestedFamily} was not found in the installed font list. Check its
            local name or choose a listed font to avoid an unintended fallback.
          </p>
        )}
        <p className="m-0 text-xs text-stone-500">
          Fonts installed on this computer. Font files are not embedded in the
          project.
        </p>
      </PopoverContent>
    </Popover>
  );
}
