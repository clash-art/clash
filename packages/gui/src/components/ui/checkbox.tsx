import { Check } from "@phosphor-icons/react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

import { cn } from "../../lib/cn";

type CheckboxProps = ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>;

export const Checkbox = forwardRef<
  ElementRef<typeof CheckboxPrimitive.Root>,
  CheckboxProps
>(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      {...props}
      ref={ref}
      data-slot="checkbox"
      className={cn(
        "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border border-input bg-background text-white transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/40 focus-visible:ring-offset-0",
        "data-[state=checked]:border-info data-[state=checked]:bg-info",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator">
        <Check className="size-3" weight="bold" aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});
