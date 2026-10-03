import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { cn } from "../../lib/cn";

export function DropdownMenu(
  { modal = false, ...props }: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Root>,
) {
  return <DropdownMenuPrimitive.Root modal={modal} {...props} />;
}

export const DropdownMenuTrigger = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(function DropdownMenuTrigger(props, ref) {
  return (
    <DropdownMenuPrimitive.Trigger
      ref={ref}
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  );
});

export function dropdownMenuItemClassName({
  disabled = false,
  className,
}: {
  disabled?: boolean;
  className?: string;
} = {}) {
    return cn(
    "app-select-item app-select-focus relative flex min-h-8 w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none select-none app-interactive-surface",
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
    disabled && "pointer-events-none opacity-50",
    className,
  );
}

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(function DropdownMenuContent(
  { className, align = "start", sideOffset = 4, collisionPadding = 12, ...props },
  ref,
) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        data-slot="dropdown-menu-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "app-select-content z-[80] max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-32 origin-[var(--radix-dropdown-menu-content-transform-origin)] overflow-x-hidden overflow-y-auto rounded-lg p-1 text-foreground outline-none",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(function DropdownMenuItem({ className, disabled, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      data-slot="dropdown-menu-item"
      disabled={disabled}
      className={dropdownMenuItemClassName({ disabled, className })}
      {...props}
    />
  );
});

export const DropdownMenuCheckboxItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(function DropdownMenuCheckboxItem({ className, disabled, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      data-slot="dropdown-menu-checkbox-item"
      disabled={disabled}
      className={dropdownMenuItemClassName({ disabled, className })}
      {...props}
    />
  );
});

export const DropdownMenuItemIndicator = DropdownMenuPrimitive.ItemIndicator;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;

export const DropdownMenuSubTrigger = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>
>(function DropdownMenuSubTrigger({ className, disabled, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      data-slot="dropdown-menu-sub-trigger"
      disabled={disabled}
      className={dropdownMenuItemClassName({ disabled, className })}
      {...props}
    />
  );
});

export const DropdownMenuSubContent = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(function DropdownMenuSubContent(
  { className, sideOffset = 2, collisionPadding = 12, ...props },
  ref,
) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        ref={ref}
        data-slot="dropdown-menu-sub-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "app-select-content z-[90] flex max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-44 flex-col gap-[var(--select-item-gap)] origin-[var(--radix-dropdown-menu-content-transform-origin)] overflow-x-hidden overflow-y-auto rounded-lg p-1 text-foreground outline-none",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});

export const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(function DropdownMenuSeparator({ className, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Separator
      ref={ref}
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
});
