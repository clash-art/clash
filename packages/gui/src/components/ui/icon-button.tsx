import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/cn';
import { Button } from './button';

/**
 * Icon-only button primitive. Enforces the a11y wiring that callers
 * regularly forget: aria-label is required (no anonymous icon buttons),
 * type=button is default (never submit), focus-visible ring is built in,
 * touch targets meet AA at sm/md and AAA at lg.
 *
 * Variants:
   *   default     — ghost style, hover surface tint. The 95% case.
 *   active      — for "X is currently selected" pills (run-on plug etc.).
 *                 Brand-tinted bg/text.
 *   destructive — red hover. For delete / remove / trash actions.
 *
 * Sizes (square, hit target ≥ visual):
   *   sm — 32 px (only for secondary inline actions like in-row delete)
 *   md — 36 px (toolbar default; meets AA 2.5.8)
 *   lg — 44 px (meets AAA 2.5.5; use for primary mobile-touch CTAs)
 */
export const iconButtonVariants = cva(
    'inline-flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-offset-0 disabled:opacity-40 disabled:cursor-not-allowed',
    {
        variants: {
            variant: {
                default:
                    'text-slate-800 hover:bg-warm-muted dark:text-slate-200 focus-visible:ring-ring focus-visible:ring-offset-warm-surface',
                active:
                    'bg-brand/10 text-brand hover:bg-brand/20 dark:bg-brand/15 dark:hover:bg-brand/25 focus-visible:ring-ring focus-visible:ring-offset-warm-surface',
                destructive:
                    'text-slate-700 hover:bg-red-50 hover:text-red-600 dark:text-slate-300 dark:hover:bg-red-950/40 dark:hover:text-red-300 focus-visible:ring-red-500 focus-visible:ring-offset-warm-surface',
            },
            size: {
                sm: 'h-8 w-8 min-h-[32px] min-w-[32px]',
                md: 'h-9 w-9 min-h-[36px] min-w-[36px]',
                lg: 'h-11 w-11 min-h-[44px] min-w-[44px]',
            },
            shape: {
                rounded: 'rounded-lg',
                circle: 'rounded-full',
            },
        },
        defaultVariants: {
            variant: 'default',
            size: 'md',
            shape: 'rounded',
        },
    },
);

export interface IconButtonProps
    extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>,
        VariantProps<typeof iconButtonVariants> {
    /** Required for screen readers — there's no visible text. */
    label: string;
    /** The icon node. Pass it without aria-hidden; the wrapper handles that. */
    icon: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
    ({ icon, label, variant, size, shape, className, type = 'button', ...rest }, ref) => {
        return (
            <Button
                ref={ref}
                type={type}
                variant={null}
                size={null}
                shape={null}
                aria-label={label}
                className={cn(iconButtonVariants({ variant, size, shape }), className)}
                {...rest}
            >
                <span aria-hidden="true" className="flex">
                    {icon}
                </span>
            </Button>
        );
    },
);
IconButton.displayName = 'IconButton';
