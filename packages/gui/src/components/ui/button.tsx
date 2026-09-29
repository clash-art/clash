import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/cn';

export const buttonVariants = cva(
  'app-control inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-[color,background-color,border-color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'border border-border bg-background text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground',
        primary:
          'border border-transparent bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        destructive:
          'border border-destructive/20 bg-destructive/8 text-destructive shadow-xs hover:bg-destructive/14 focus-visible:ring-destructive/25',
      },
      size: {
        sm: 'px-3 py-1.5 text-xs',
        md: 'px-4 py-2 text-sm',
        lg: 'px-5 py-3 text-base',
      },
      shape: {
        rounded: 'rounded-xl',
        pill: 'rounded-full',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
      shape: 'rounded',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ children, className, leftIcon, rightIcon, shape = 'rounded', size = 'md', type = 'button', variant = 'default', ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        data-slot="button"
        data-variant={variant ?? undefined}
        data-size={size ?? undefined}
        data-shape={shape ?? undefined}
        className={cn(buttonVariants({ shape, size, variant }), className)}
        {...props}
      >
        {leftIcon ? (
          <span aria-hidden="true" className="flex shrink-0">
            {leftIcon}
          </span>
        ) : null}
        {children}
        {rightIcon ? (
          <span aria-hidden="true" className="flex shrink-0">
            {rightIcon}
          </span>
        ) : null}
      </button>
    );
  },
);
Button.displayName = 'Button';
