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
    "app-tab-trigger outline-none transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 focus-visible:ring-offset-0",
    selected ? "app-tab-trigger-selected" : "app-tab-trigger-rest",
    className,
  );
}
