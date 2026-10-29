import type { AcpSessionConfigOption } from '@clash/web-ui/hooks/useClashRuntime';
import {
    commandActionFromAvailableCommand,
    type AvailableCommand,
} from '@clash/web-ui/lib/acpEvents';

export type AcpConfigSelectValue = {
    value: string;
    name: string;
    description?: string | null;
};

export function isFastSessionConfigOption(option: AcpSessionConfigOption): boolean {
    return option.id === 'fast'
        || option.id === 'fast-mode'
        || (
            option.category === 'model_config'
            && /\bfast\b/i.test(`${option.id} ${option.name}`)
        );
}


/** dsh-acp advertises the agent-preset roster as `id: "agent"`, `name: "Agent"`.
 * ACP has no icon field, so the composer special-cases this option (Backchat parity). */
export function isAgentPresetConfigOption(
    option: AcpSessionConfigOption,
): boolean {
    const normalizedId = option.id.trim().toLowerCase().replaceAll('_', '-');
    const normalizedName = option.name
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '');
    return (
        normalizedId === 'agent'
        || normalizedId === 'preset'
        || normalizedId === 'agent-preset'
        || normalizedName === 'agent'
        || normalizedName === 'preset'
    );
}

export function sessionConfigOptionEnabled(option: AcpSessionConfigOption): boolean {
    if (option.type === 'boolean') return option.currentValue === true;
    if (option.type !== 'select' || typeof option.currentValue !== 'string') return false;
    return ['on', 'true', 'enabled'].includes(option.currentValue.toLowerCase());
}

export function buildRunMenuConfigOptions(
    options: readonly AcpSessionConfigOption[] | undefined,
): AcpSessionConfigOption[] {
    return (options ?? []).filter((option) => (
        option.category === 'model'
        || option.category === 'thought_level'
        || option.category === 'model_config'
        || isFastSessionConfigOption(option)
    ));
}

export function buildComposerConfigOptions(
    options: readonly AcpSessionConfigOption[] | undefined,
): AcpSessionConfigOption[] {
    return (options ?? []).filter((option) => (
        option.category !== 'model'
        && option.category !== 'thought_level'
        && option.category !== 'mode'
        && option.id !== 'mode'
        && option.id !== 'collaboration_mode'
        && option.category !== 'model_config'
        && !isFastSessionConfigOption(option)
    ));
}

export function findSelectConfigOption(
    options: readonly AcpSessionConfigOption[] | undefined,
    id: string,
): AcpSessionConfigOption | null {
    return options?.find((option) => (
        option.type === 'select'
        && option.id === id
        && Array.isArray(option.options)
    )) ?? null;
}

export function withSessionStateCommands(
    commands: readonly AvailableCommand[],
    configOptions: readonly AcpSessionConfigOption[] | undefined,
): AvailableCommand[] {
    const collaboration = findSelectConfigOption(configOptions, 'collaboration_mode');
    const supportsPlan = collaboration?.options?.some((entry) => (
        'options' in entry
            ? entry.options.some((option) => option.value === 'plan')
            : entry.value === 'plan'
    )) ?? false;
    if (!supportsPlan || !collaboration) {
        return [...commands];
    }
    const commandAction = {
        kind: 'setConfigOption',
        configId: collaboration.id,
        value: 'plan',
        resetValue: collaboration.currentValue === 'plan'
            ? 'default'
            : collaboration.currentValue,
        presentation: 'state',
    } as const;
    const existingPlan = commands.find((command) => command.name.toLowerCase() === 'plan');
    if (existingPlan) {
        return commands.map((command) => {
            if (command !== existingPlan || commandActionFromAvailableCommand(command)) {
                return command;
            }
            return {
                ...command,
                _meta: {
                    ...(command._meta ?? {}),
                    commandAction,
                },
            };
        });
    }
    return [
        {
            name: 'plan',
            description: 'Enter plan mode for this session',
            kind: 'session-state',
            _meta: {
                commandAction,
            },
        },
        ...commands,
    ];
}

export function configModeOptionPresentation(
    option: AcpConfigSelectValue,
): {
    label: string;
    description?: string;
    warning?: boolean;
} {
    if (option.value === 'read-only') {
        return {
            label: 'Ask for approval',
            description: 'Always ask to edit external files and use the internet',
        };
    }
    if (option.value === 'agent') {
        return {
            label: 'Approve for me',
            description: 'Only ask for actions detected as potentially unsafe',
        };
    }
    if (option.value === 'agent-full-access') {
        return {
            label: 'Full access',
            description: 'Unrestricted access to the internet and any file on your computer',
            warning: true,
        };
    }
    return {
        label: option.name,
        ...(option.description ? { description: option.description } : {}),
    };
}
