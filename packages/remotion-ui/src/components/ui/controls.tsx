import React from 'react';
import {
  SelectMenu,
  type SelectOption,
  type SelectValue,
} from '@clash/gui/components/ui/select';

export type TimelineIconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

const TIMELINE_ICON_BUTTON_INTERACTION_CLASS =
  'transition-[filter] duration-150 ease-out hover:brightness-95 active:brightness-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:hover:brightness-100 motion-reduce:transition-none';

export const TimelineIconButton = React.forwardRef<HTMLButtonElement, TimelineIconButtonProps>(
  function TimelineIconButton({ type = 'button', className, ...props }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={[className, TIMELINE_ICON_BUTTON_INTERACTION_CLASS].filter(Boolean).join(' ')}
        {...props}
      />
    );
  },
);

export const RemotionIconButton = TimelineIconButton;

export type RemotionButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

export const RemotionButton = React.forwardRef<HTMLButtonElement, RemotionButtonProps>(
  function RemotionButton({ type = 'button', ...props }, ref) {
    return <button ref={ref} type={type} {...props} />;
  },
);

export type RemotionFileInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

export const RemotionFileInput = React.forwardRef<HTMLInputElement, RemotionFileInputProps>(
  function RemotionFileInput(props, ref) {
    return <input ref={ref} type="file" {...props} />;
  },
);

export type RemotionInputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const RemotionInput = React.forwardRef<HTMLInputElement, RemotionInputProps>(
  function RemotionInput(props, ref) {
    return <input ref={ref} {...props} />;
  },
);

type RemotionNumberInputProps = Omit<RemotionInputProps, 'type' | 'value' | 'defaultValue' | 'onChange'> & {
  value: number;
  onValueChange: (value: number) => void;
};

// Keep native number-input editing (including an unfinished minus or decimal)
// separate from the finite numbers persisted in the Timeline.
export function RemotionNumberInput({ value, onValueChange, onBlur, ...props }: RemotionNumberInputProps) {
  const [edit, setEdit] = React.useState({ observed: value, draft: String(value) });
  let draft = edit.draft;
  if (!Object.is(edit.observed, value)) {
    draft = String(value);
    setEdit({ observed: value, draft });
  }
  return (
    <input
      {...props}
      type="number"
      value={draft}
      onChange={(event) => {
        setEdit({ observed: value, draft: event.target.value });
        const next = event.target.valueAsNumber;
        if (Number.isFinite(next)) onValueChange(next);
      }}
      onBlur={(event) => {
        setEdit({ observed: value, draft: String(value) });
        onBlur?.(event);
      }}
    />
  );
}

export type RemotionSelectProps<Value extends SelectValue = string> = {
  value: Value;
  options: ReadonlyArray<SelectOption<Value>>;
  onValueChange: (value: Value) => void;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  className?: string;
  containerClassName?: string;
};

export function RemotionSelect<Value extends SelectValue = string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  title,
  disabled,
  className,
  containerClassName = 'w-full',
}: RemotionSelectProps<Value>) {
  return (
    <SelectMenu
      value={value}
      options={[...options]}
      onValueChange={(nextValue) => onValueChange(nextValue)}
      ariaLabel={ariaLabel}
      title={title}
      disabled={disabled}
      variant="field"
      size="sm"
      menuWidth="trigger"
      context="timeline"
      className={containerClassName}
      triggerClassName={className}
    />
  );
}

export type RemotionTextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const RemotionTextarea = React.forwardRef<HTMLTextAreaElement, RemotionTextareaProps>(
  function RemotionTextarea(props, ref) {
    return <textarea ref={ref} {...props} />;
  },
);

export type TimelineRangeInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

export const TimelineRangeInput = React.forwardRef<HTMLInputElement, TimelineRangeInputProps>(
  function TimelineRangeInput(props, ref) {
    return <input ref={ref} type="range" {...props} />;
  },
);

export type TimelineTextInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  onCommit?: () => void;
  onCancel?: () => void;
};

export const TimelineTextInput = React.forwardRef<HTMLInputElement, TimelineTextInputProps>(
  function TimelineTextInput({ onCommit, onCancel, onKeyDown, ...props }, ref) {
    return (
      <input
        ref={ref}
        type="text"
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) {
            return;
          }
          if (event.key === 'Enter') {
            onCommit?.();
          } else if (event.key === 'Escape') {
            onCancel?.();
          }
        }}
        {...props}
      />
    );
  },
);

export type TimelineColorInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

export const TimelineColorInput = React.forwardRef<HTMLInputElement, TimelineColorInputProps>(
  function TimelineColorInput(props, ref) {
    return <input ref={ref} type="color" {...props} />;
  },
);
