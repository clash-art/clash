import {
    useCallback,
    useMemo,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from 'react';
import { CaretDown, CaretRight, Check } from '@phosphor-icons/react';
import { DropdownMenu as DropdownMenuPrimitive, Select as SelectPrimitive } from 'radix-ui';

import { cn } from '../../lib/cn';
import { Button } from './button';
import { useControlContext, type ControlContextName } from './control-context';
import { Tooltip } from './tooltip';

export type SelectValue = string | number | boolean;

export interface SelectOption<Value extends SelectValue = string> {
    value: Value;
    label: ReactNode;
    description?: ReactNode;
    descriptionPlacement?: "below" | "inline";
    searchText?: string;
    icon?: ReactNode;
    disabled?: boolean;
    selected?: boolean;
    rightAdornment?: ReactNode;
    hasSubmenu?: boolean;
    submenuLabel?: ReactNode;
    submenuSections?: SelectSection<Value>[];
}

export interface SelectSection<Value extends SelectValue = string> {
    id: string;
    label?: ReactNode;
    options: SelectOption<Value>[];
}

export interface SelectMenuProps<Value extends SelectValue = string> {
    value: Value;
    options?: SelectOption<Value>[];
    sections?: SelectSection<Value>[];
    onValueChange: (value: Value, option: SelectOption<Value>) => void;
    ariaLabel: string;
    placeholder?: ReactNode;
    triggerLabel?: ReactNode;
    triggerPrefix?: ReactNode;
    triggerSuffix?: ReactNode;
    title?: string;
    disabled?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    variant?: 'inline' | 'pill' | 'field';
    size?: 'sm' | 'md';
    align?: 'start' | 'end';
    placement?: 'top' | 'bottom' | 'auto';
    menuWidth?: number | 'trigger' | 'auto';
    maxMenuHeight?: number;
    submenuWidth?: number;
    showCaret?: boolean;
    stopPropagation?: boolean;
    className?: string;
    triggerClassName?: string;
    triggerTestId?: string;
    menuClassName?: string;
    context?: ControlContextName;
}

const VIEWPORT_MARGIN = 12;
const MENU_OFFSET = 8;
const SUBMENU_OFFSET = 2;

const triggerVariantClasses = {
    inline:
        'app-compact-control max-w-full justify-start rounded-md border-0 bg-transparent px-1.5 text-sm font-medium shadow-none',
    pill:
        'justify-between rounded-full border border-input bg-transparent px-3 text-sm font-medium text-foreground',
    field:
        'w-full justify-between rounded-lg border border-input bg-transparent px-3 text-sm font-medium text-foreground dark:bg-input/30 dark:hover:bg-input/50',
};

const triggerSizeClasses = {
    sm: '',
    md: '',
};

function sameValue(a: SelectValue, b: SelectValue) {
    return String(a) === String(b);
}

function menuItemClassName({
    selected = false,
    disabled = false,
    className,
}: {
    selected?: boolean;
    disabled?: boolean;
    className?: string;
} = {}) {
    return cn(
        'app-select-item app-select-focus flex w-full items-center gap-2 rounded-md py-1.5 pl-2 pr-3 text-left text-sm outline-none select-none',
        selected && 'data-[checked=true]:bg-[var(--control-bg-open)]',
        disabled && 'cursor-not-allowed opacity-45',
        className,
    );
}

function DropdownSelectMenu<Value extends SelectValue = string>({
    value,
    options,
    sections,
    onValueChange,
    ariaLabel,
    placeholder = 'Select',
    triggerLabel,
    triggerPrefix,
    triggerSuffix,
    title,
    disabled = false,
    open: controlledOpen,
    onOpenChange,
    variant = 'field',
    size = 'md',
    align = 'start',
    placement = 'auto',
    menuWidth = 'auto',
    maxMenuHeight = 320,
    submenuWidth = 220,
    showCaret = true,
    stopPropagation = false,
    className,
    triggerClassName,
    triggerTestId,
    menuClassName,
    context,
}: SelectMenuProps<Value>) {
    const inheritedContext = useControlContext();
    const resolvedContext = context ?? inheritedContext;
    const normalizedSections = useMemo<SelectSection<Value>[]>(() => {
        if (sections) return sections;
        return [{ id: 'options', options: options ?? [] }];
    }, [options, sections]);
    const flatOptions = useMemo(
        () => normalizedSections.flatMap((section) => [
            ...section.options,
            ...section.options.flatMap((option) => option.submenuSections?.flatMap((submenu) => submenu.options) ?? []),
        ]),
        [normalizedSections],
    );
    const selectedOption = flatOptions.find((option) => option.selected ?? sameValue(option.value, value));
    const label = triggerLabel ?? selectedOption?.label ?? placeholder;
    const isDisabled = disabled || flatOptions.length === 0;
    const contentWidth =
        menuWidth === 'trigger'
            ? 'var(--radix-dropdown-menu-trigger-width)'
            : typeof menuWidth === 'number'
                ? `min(${menuWidth}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))`
                : undefined;

    const handleEventBoundary = (event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>) => {
        if (stopPropagation) event.stopPropagation();
    };

    const selectOption = useCallback((option: SelectOption<Value>) => {
        if (option.disabled) return;
        onValueChange(option.value, option);
    }, [onValueChange]);

    const trigger = (
        <DropdownMenuPrimitive.Trigger asChild>
            <Button
                variant={null}
                size={null}
                shape={null}
                aria-label={ariaLabel}
                data-testid={triggerTestId}
                data-slot="select-trigger"
                data-size={size}
                data-variant={variant}
                data-context={resolvedContext}
                disabled={isDisabled}
                onClick={handleEventBoundary}
                onPointerDown={handleEventBoundary}
                className={cn(
                    'app-select-trigger clash-select-trigger inline-flex min-w-0 items-center gap-1.5 transition-colors outline-none',
                    'focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50',
                    'disabled:cursor-not-allowed disabled:opacity-45',
                    triggerVariantClasses[variant],
                    triggerSizeClasses[size],
                    triggerClassName,
                )}
            >
                {triggerPrefix}
                <span className="min-w-0 flex-1 truncate text-left">{label}</span>
                {triggerSuffix}
                {showCaret ? <CaretDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
            </Button>
        </DropdownMenuPrimitive.Trigger>
    );

    return (
        <DropdownMenuPrimitive.Root
            modal={false}
            open={controlledOpen}
            onOpenChange={onOpenChange}
        >
            <div className={cn('relative inline-flex min-w-0', className)}>
                {title ? <Tooltip label={title}>{trigger}</Tooltip> : trigger}
            </div>
            <DropdownMenuPrimitive.Portal>
                <DropdownMenuPrimitive.Content
                    aria-label={ariaLabel}
                    data-context={resolvedContext}
                    side={placement === 'top' ? 'top' : 'bottom'}
                    align={align}
                    sideOffset={MENU_OFFSET}
                    collisionPadding={VIEWPORT_MARGIN}
                    style={{
                        width: contentWidth,
                        maxHeight: `min(var(--radix-dropdown-menu-content-available-height), ${maxMenuHeight}px)`,
                    }}
                    className={cn(
                        'app-select-content z-[80] overflow-hidden rounded-lg text-foreground',
                        menuWidth === 'auto' && 'min-w-[min(var(--radix-dropdown-menu-trigger-width),calc(100vw-24px))]',
                        menuClassName,
                    )}
                    onClick={handleEventBoundary}
                    onPointerDown={handleEventBoundary}
                >
                    <div className="max-h-[inherit] overflow-y-auto p-1.5">
                        {normalizedSections.map((section, sectionIndex) => (
                            <DropdownSelectMenuSection
                                key={section.id}
                                section={section}
                                sectionIndex={sectionIndex}
                                value={value}
                                selectOption={selectOption}
                                submenuWidth={submenuWidth}
                                context={resolvedContext}
                            />
                        ))}
                    </div>
                </DropdownMenuPrimitive.Content>
            </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
    );
}

function RadixSelectMenu<Value extends SelectValue = string>({
    value,
    options,
    sections,
    onValueChange,
    ariaLabel,
    placeholder = 'Select',
    triggerLabel,
    triggerPrefix,
    triggerSuffix,
    title,
    disabled = false,
    open: controlledOpen,
    onOpenChange,
    variant = 'field',
    size = 'md',
    align = 'start',
    placement = 'auto',
    menuWidth = 'auto',
    maxMenuHeight = 320,
    showCaret = true,
    stopPropagation = false,
    className,
    triggerClassName,
    triggerTestId,
    menuClassName,
    context,
}: SelectMenuProps<Value>) {
    const inheritedContext = useControlContext();
    const resolvedContext = context ?? inheritedContext;
    const normalizedSections = useMemo<SelectSection<Value>[]>(() => {
        if (sections) return sections;
        return [{ id: 'options', options: options ?? [] }];
    }, [options, sections]);
    const flatOptions = useMemo(
        () => normalizedSections.flatMap((section) => section.options),
        [normalizedSections],
    );
    const selectedOption = flatOptions.find((option) => option.selected ?? sameValue(option.value, value));
    const selectedStringValue = selectedOption ? String(selectedOption.value) : String(value);
    const label = triggerLabel ?? selectedOption?.label ?? placeholder;
    const isDisabled = disabled || flatOptions.length === 0;
    const contentWidth =
        menuWidth === 'trigger'
            ? 'var(--radix-select-trigger-width)'
            : typeof menuWidth === 'number'
                ? `min(${menuWidth}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))`
                : undefined;

    const handleValueChange = useCallback((nextValue: string) => {
        const option = flatOptions.find((candidate) => String(candidate.value) === nextValue);
        if (!option || option.disabled) return;
        onValueChange(option.value, option);
    }, [flatOptions, onValueChange]);

    const handleEventBoundary = (event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>) => {
        if (stopPropagation) event.stopPropagation();
    };

    const trigger = (
        <SelectPrimitive.Trigger
            aria-label={ariaLabel}
            data-testid={triggerTestId}
            data-slot="select-trigger"
            data-size={size}
            data-variant={variant}
            data-context={resolvedContext}
            onClick={handleEventBoundary}
            onPointerDown={handleEventBoundary}
            className={cn(
                'app-select-trigger clash-select-trigger inline-flex min-w-0 items-center gap-1.5 transition-colors outline-none',
                'focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50',
                'disabled:cursor-not-allowed disabled:opacity-45',
                triggerVariantClasses[variant],
                triggerSizeClasses[size],
                triggerClassName,
            )}
        >
            {triggerPrefix}
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            {triggerSuffix}
            {showCaret ? (
                <SelectPrimitive.Icon asChild>
                    <CaretDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                </SelectPrimitive.Icon>
            ) : null}
        </SelectPrimitive.Trigger>
    );

    return (
        <SelectPrimitive.Root
            value={selectedStringValue}
            open={controlledOpen}
            onOpenChange={onOpenChange}
            onValueChange={handleValueChange}
            disabled={isDisabled}
        >
            <div className={cn('relative inline-flex min-w-0', className)}>
                {title ? <Tooltip label={title}>{trigger}</Tooltip> : trigger}
            </div>
            <SelectPrimitive.Portal>
                <SelectPrimitive.Content
                    aria-label={ariaLabel}
                    data-context={resolvedContext}
                    position="popper"
                    side={placement === 'top' ? 'top' : 'bottom'}
                    align={align}
                    sideOffset={MENU_OFFSET}
                    collisionPadding={VIEWPORT_MARGIN}
                    style={{
                        width: contentWidth,
                        maxHeight: `min(var(--radix-select-content-available-height), ${maxMenuHeight}px)`,
                    }}
                    className={cn(
                        'app-select-content z-[80] overflow-hidden rounded-lg text-foreground',
                        menuWidth === 'auto' && 'min-w-[min(var(--radix-select-trigger-width),calc(100vw-24px))]',
                        menuClassName,
                    )}
                    onClick={handleEventBoundary}
                    onPointerDown={handleEventBoundary}
                >
                    <SelectPrimitive.Viewport className="max-h-[inherit] overflow-y-auto p-1.5">
                        {normalizedSections.map((section, sectionIndex) => (
                            <SelectPrimitive.Group
                                key={section.id}
                                className={cn(sectionIndex > 0 && 'mt-1.5 border-t border-border pt-1.5')}
                            >
                                {section.label ? (
                                    <SelectPrimitive.Label className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
                                        {section.label}
                                    </SelectPrimitive.Label>
                                ) : null}
                                <div className="space-y-0.5">
                                    {section.options.map((option) => {
                                        const selected = option.selected ?? sameValue(option.value, value);
                                        const textValue = typeof option.label === 'string' ? option.label : undefined;
                                        return (
                                            <SelectPrimitive.Item
                                                key={String(option.value)}
                                                value={String(option.value)}
                                                disabled={option.disabled}
                                                textValue={textValue}
                                                className={menuItemClassName({ selected, disabled: option.disabled })}
                                            >
                                                {option.icon ? (
                                                    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
                                                        {option.icon}
                                                    </span>
                                                ) : null}
                                                <span className="min-w-0 flex-1">
                                                    <SelectPrimitive.ItemText>
                                                        <span className="block truncate font-medium leading-5">{option.label}</span>
                                                    </SelectPrimitive.ItemText>
                                                    {option.description ? (
                                                        <span className="block truncate text-xs font-normal leading-4 text-muted-foreground">
                                                            {option.description}
                                                        </span>
                                                    ) : null}
                                                </span>
                                                <span className="app-select-selected flex size-5 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
                                                    {option.rightAdornment ?? (
                                                        <SelectPrimitive.ItemIndicator>
                                                            <Check className="h-4 w-4" weight="bold" />
                                                        </SelectPrimitive.ItemIndicator>
                                                    )}
                                                </span>
                                            </SelectPrimitive.Item>
                                        );
                                    })}
                                </div>
                            </SelectPrimitive.Group>
                        ))}
                    </SelectPrimitive.Viewport>
                </SelectPrimitive.Content>
            </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
    );
}

function DropdownSelectMenuSection<Value extends SelectValue>({
    section,
    sectionIndex,
    value,
    selectOption,
    submenuWidth,
    context,
}: {
    section: SelectSection<Value>;
    sectionIndex: number;
    value: Value;
    selectOption: (option: SelectOption<Value>) => void;
    submenuWidth: number;
    context: ControlContextName;
}) {
    const selectedSectionValue = section.options.find((option) => option.selected ?? sameValue(option.value, value))?.value;

    return (
        <DropdownMenuPrimitive.Group
            className={cn(sectionIndex > 0 && 'mt-1.5 border-t border-border pt-1.5')}
        >
            {section.label ? (
                <DropdownMenuPrimitive.Label className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
                    {section.label}
                </DropdownMenuPrimitive.Label>
            ) : null}
            <DropdownMenuPrimitive.RadioGroup
                value={selectedSectionValue === undefined ? undefined : String(selectedSectionValue)}
                className="space-y-0.5"
            >
                {section.options.map((option) => {
                    const selected = option.selected ?? sameValue(option.value, value);
                    const opensSubmenu = option.hasSubmenu || !!option.submenuSections?.length;
                    const submenuKey = String(option.value);
                    if (opensSubmenu) {
                        return (
                            <DropdownMenuPrimitive.Sub key={submenuKey}>
                                <DropdownMenuPrimitive.SubTrigger
                                    disabled={option.disabled}
                                    data-checked={selected}
                                    data-context={context}
                                    className={menuItemClassName({ selected, disabled: option.disabled })}
                                >
                                    {option.icon ? (
                                        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
                                            {option.icon}
                                        </span>
                                    ) : null}
                                    <span className={option.descriptionPlacement === "inline" ? "flex min-w-0 flex-1 items-center gap-4" : "min-w-0 flex-1"}>
                                        <span className="block min-w-0 flex-1 truncate font-medium leading-5">{option.label}</span>
                                        {option.description ? (
                                            <span className={option.descriptionPlacement === "inline" ? "max-w-[60%] truncate text-right font-normal leading-5 text-muted-foreground" : "block truncate text-xs font-normal leading-4 text-muted-foreground"}>
                                                {option.description}
                                            </span>
                                        ) : null}
                                    </span>
                                    <span className="app-select-selected flex size-5 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
                                        {option.rightAdornment ?? <CaretRight className="h-4 w-4" />}
                                    </span>
                                </DropdownMenuPrimitive.SubTrigger>
                                <DropdownMenuPrimitive.Portal>
                                    <DropdownMenuPrimitive.SubContent
                                        aria-label={String(option.submenuLabel ?? option.label)}
                                        data-context={context}
                                        sideOffset={SUBMENU_OFFSET}
                                        collisionPadding={VIEWPORT_MARGIN}
                                        style={{ width: submenuWidth }}
                                        className="app-select-content z-[90] overflow-hidden rounded-lg text-foreground"
                                    >
                                        <div className="max-h-[min(var(--radix-dropdown-menu-content-available-height),320px)] overflow-y-auto p-1.5">
                                            {(option.submenuSections ?? []).map((submenuSection, submenuIndex) => (
                                                <DropdownSelectMenuSection
                                                    key={submenuSection.id}
                                                    section={submenuSection}
                                                    sectionIndex={submenuIndex}
                                                    value={value}
                                                    selectOption={selectOption}
                                                    submenuWidth={submenuWidth}
                                                    context={context}
                                                />
                                            ))}
                                        </div>
                                    </DropdownMenuPrimitive.SubContent>
                                </DropdownMenuPrimitive.Portal>
                            </DropdownMenuPrimitive.Sub>
                        );
                    }

                    return (
                        <DropdownMenuPrimitive.RadioItem
                            key={String(option.value)}
                            value={String(option.value)}
                            disabled={option.disabled}
                            onSelect={() => selectOption(option)}
                            className={menuItemClassName({ selected, disabled: option.disabled })}
                        >
                            {option.icon ? (
                                <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
                                    {option.icon}
                                </span>
                            ) : null}
                            <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium leading-5">{option.label}</span>
                                {option.description ? (
                                    <span className="block truncate text-xs font-normal leading-4 text-muted-foreground">
                                        {option.description}
                                    </span>
                                ) : null}
                            </span>
                            <span className="app-select-selected flex size-5 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
                                {option.rightAdornment ?? (
                                    <DropdownMenuPrimitive.ItemIndicator>
                                        <Check className="h-4 w-4" weight="bold" />
                                    </DropdownMenuPrimitive.ItemIndicator>
                                )}
                            </span>
                        </DropdownMenuPrimitive.RadioItem>
                    );
                })}
            </DropdownMenuPrimitive.RadioGroup>
        </DropdownMenuPrimitive.Group>
    );
}

function hasSubmenuOptions<Value extends SelectValue>(
    options?: SelectOption<Value>[],
    sections?: SelectSection<Value>[],
) {
    const sectionOptions = sections?.flatMap((section) => section.options) ?? options ?? [];
    return sectionOptions.some((option) => option.hasSubmenu || !!option.submenuSections?.length);
}

export function SelectMenu<Value extends SelectValue = string>(props: SelectMenuProps<Value>) {
    if (props.sections || hasSubmenuOptions(props.options, props.sections)) {
        return <DropdownSelectMenu {...props} />;
    }
    return <RadixSelectMenu {...props} />;
}
