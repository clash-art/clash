import {
  cloneElement,
  useState,
  type MouseEventHandler,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  Tooltip as AriakitTooltip,
  TooltipAnchor,
  TooltipProvider,
  type TooltipStoreProps,
} from '@ariakit/react';

interface TooltipProps {
  label: ReactNode;
  children: ReactElement;
  placement?: TooltipStoreProps['placement'];
}

export function Tooltip({ label, children, placement }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const child = children as ReactElement<{
    onClick?: MouseEventHandler<HTMLElement>;
    onMouseLeave?: MouseEventHandler<HTMLElement>;
  }>;
  const anchor = cloneElement(child, {
    onClick: (event) => {
      child.props.onClick?.(event);
      setOpen(false);
    },
    onMouseLeave: (event) => {
      child.props.onMouseLeave?.(event);
      setOpen(false);
    },
  });

  return (
    <TooltipProvider
      open={open}
      setOpen={setOpen}
      timeout={180}
      hideTimeout={0}
      placement={placement}
    >
      <TooltipAnchor render={anchor} />
      <AriakitTooltip
        unmountOnHide
        gutter={8}
        data-placement={placement}
        className="z-50 whitespace-nowrap rounded-md border border-warm-border bg-warm-surface px-2 py-1 text-xs font-medium text-content-primary shadow-md"
      >
        {label}
      </AriakitTooltip>
    </TooltipProvider>
  );
}
