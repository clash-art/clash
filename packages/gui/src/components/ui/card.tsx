import * as React from "react";
import { Slot as SlotPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn";

const cardVariants = cva(
  "app-card rounded-[var(--surface-card-radius)] border border-[var(--surface-card-border)] bg-[var(--surface-card-bg)] text-[var(--surface-card-fg)]",
  {
    variants: {
      interaction: {
        none: "",
        border:
          "transition-[border-color] duration-[var(--motion-feedback-duration)] ease-[var(--motion-feedback-ease)] hover:border-[var(--surface-card-hover-border)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:ring-offset-warm-page motion-reduce:transition-none",
        surface:
          "transition-[border-color,background-color] duration-[var(--motion-feedback-duration)] ease-[var(--motion-feedback-ease)] hover:border-[var(--surface-card-hover-border)] hover:bg-[var(--surface-card-hover-bg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:ring-offset-warm-page motion-reduce:transition-none",
      },
      padding: {
        none: "",
        sm: "p-4",
        md: "p-5",
      },
    },
    defaultVariants: {
      interaction: "none",
      padding: "none",
    },
  },
);

function Card({
  asChild = false,
  className,
  interaction = "none",
  padding = "none",
  slot = "card",
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof cardVariants> & {
    asChild?: boolean;
    slot?: string;
  }) {
  const Comp = asChild ? SlotPrimitive.Slot : "div";

  return (
    <Comp
      data-ui="card"
      data-slot={slot}
      data-interaction={interaction}
      data-padding={padding}
      className={cn(cardVariants({ interaction, padding }), className)}
      {...props}
    />
  );
}

export { Card, cardVariants };
