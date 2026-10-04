import { cn } from "../../lib/cn";

export { Tab, TabList, TabPanel, TabProvider } from "@ariakit/react";

/** Shared tab trigger styling: flat rest, hover tint, selected fill, no mouse-focus fill. */
export function appTabTriggerClassName({
  selected = false,
  className,
}: {
  selected?: boolean;
  className?: string;
} = {}) {
  return cn(
    "app-tab-trigger outline-none transition-[color,background-color,box-shadow] focus:outline-none focus-visible:outline-none",
    selected ? "app-tab-trigger-selected" : "app-tab-trigger-rest",
    className,
  );
}
