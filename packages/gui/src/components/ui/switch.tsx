import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';

import { cn } from '../../lib/cn';

type SwitchProps = ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>;

export const Switch = forwardRef<ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(function Switch(
    { className, ...props },
    ref,
) {
    return (
        <SwitchPrimitive.Root
            {...props}
            ref={ref}
            className={cn(
                'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:ring-offset-warm-surface',
                'cursor-pointer disabled:cursor-not-allowed disabled:opacity-60',
                'border-warm-border bg-warm-muted data-[state=checked]:border-brand data-[state=checked]:bg-brand',
                className,
            )}
        >
            <SwitchPrimitive.Thumb
                className={cn(
                    'pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-150',
                    'translate-x-0.5 data-[state=checked]:translate-x-5',
                )}
            />
        </SwitchPrimitive.Root>
    );
});
