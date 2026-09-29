import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

import { cn } from "../../lib/cn";

export interface InputProps extends ComponentPropsWithoutRef<"input"> {
  controlSize?: "sm" | "default" | "lg";
}

export const Input = forwardRef<
  ElementRef<"input">,
  InputProps
>(function Input({ className, controlSize = "default", type, ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      data-size={controlSize}
      className={cn(
        "app-control w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none",
        "file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "placeholder:text-[var(--input-placeholder)] focus-visible:border-ring/60 focus-visible:bg-warm-muted/30 focus-visible:ring-0",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        "data-[size=sm]:rounded-md data-[size=sm]:px-2 data-[size=sm]:text-xs",
        "data-[size=lg]:px-3 data-[size=lg]:text-sm md:text-sm",
        "dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
});
