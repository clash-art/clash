import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
} from "react";

import { cn } from "../../lib/cn";
import { useControlContext } from "./control-context";

export interface TextareaProps extends ComponentPropsWithoutRef<"textarea"> {
  controlSize?: "sm" | "default" | "lg";
}

export const Textarea = forwardRef<ElementRef<"textarea">, TextareaProps>(
  function Textarea({ className, controlSize = "default", ...props }, ref) {
    const context = useControlContext();

    return (
      <textarea
        ref={ref}
        data-slot="textarea"
        data-size={controlSize}
        data-context={context}
        className={cn(
          "app-control field-sizing-content flex min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none",
          "placeholder:text-muted-foreground focus-visible:border-ring/60 focus-visible:bg-warm-muted/30 focus-visible:ring-0",
          "disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50",
          "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
          "data-[size=sm]:min-h-14 data-[size=sm]:rounded-md data-[size=sm]:px-2 data-[size=sm]:py-1.5 data-[size=sm]:text-xs",
          "data-[size=lg]:min-h-24 data-[size=lg]:px-3 data-[size=lg]:text-sm md:text-sm",
          "dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
          className,
        )}
        {...props}
      />
    );
  },
);
