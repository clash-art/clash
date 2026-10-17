import { z } from 'zod';

/**
 * Facts an account states about itself, other than its secrets.
 *
 * Which of a vendor's services issued a key is one of these: the credential cannot say, so the
 * account must. The declaration is data rather than code because three parties need the same
 * answer — the form that offers the choice, the host that resolves it, and the validator that
 * rejects a value outside it. A default living in the request path would be invisible to the person
 * making the choice, and the form would need a second copy to pre-select anything.
 */
export const AccountSettingOptionSchema = z.object({
  value: z.string().trim().min(1),
  /** What the person choosing reads. Names the service, not our identifier for it. */
  label: z.string().trim().min(1),
}).strict();

export const AccountSettingSchema = z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  /** A closed set makes this a choice; without it the setting is free text. */
  options: z.array(AccountSettingOptionSchema).nonempty().optional(),
  /** What the setting is when nobody said. Must be one of the options, when there are options. */
  defaultValue: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
}).strict().superRefine((setting, ctx) => {
  if (setting.options && setting.defaultValue
    && !setting.options.some((option) => option.value === setting.defaultValue)) {
    ctx.addIssue({
      code: "custom",
      path: ['defaultValue'],
      message:
        `Default "${setting.defaultValue}" is not one of the options. A default outside the set `
        + 'would be stored, pass validation, and then match nothing downstream.',
    });
  }
});

export type AccountSetting = z.infer<typeof AccountSettingSchema>;

/**
 * Per-upstream settings.
 *
 * Keyed by vendor rather than by provider id, because the question belongs to the vendor: Google
 * runs two services regardless of whose account reaches them.
 */
export const ACCOUNT_SETTINGS: Readonly<Record<string, readonly AccountSetting[]>> = {
  google: [
    {
      key: 'service',
      label: 'Service',
      options: [
        { value: 'agent-platform', label: 'Gemini Enterprise Agent Platform (aiplatform.googleapis.com)' },
        { value: 'ai-studio', label: 'Gemini Developer API (generativelanguage.googleapis.com)' },
      ],
      // Agent Platform serves the whole catalogue -- Veo and the Gemini text models exist only
      // there -- while the Developer API additionally needs the Gemini API enabled on the project
      // behind the key, which a Cloud key does not have by default.
      defaultValue: 'agent-platform',
      description: 'Which Google service issued this key. Both accept the same kind of key.',
    },
    {
      key: 'region',
      label: 'Region',
      // Free text rather than a menu: Google adds locations, and a stale menu would refuse one that
      // works. Agent Platform rejects an unknown location itself, and says so clearly.
      //
      // `global` is the default because model availability is widest there -- measured:
      // gemini-3.1-flash-image answers on global and 404s on us-central1.
      defaultValue: 'global',
      description: 'Agent Platform location, e.g. global or us-central1. Unused by the Developer API.',
    },
  ],
  minimax: [
    {
      key: 'service',
      label: 'Service',
      options: [
        { value: 'global', label: 'International (api.minimax.io)' },
        { value: 'cn', label: 'Mainland China (api.minimaxi.com)' },
      ],
      // Accounts predate this choice, and moving them to a host their key is unknown to -- without
      // anyone asking -- would break the ones that work today.
      defaultValue: 'global',
      description: 'Which MiniMax service issued this key. They do not share a login.',
    },
  ],
};

/**
 * The effective value of one declared setting, treating a missing default as required.
 *
 * Whether absence is acceptable is a property of the declaration and of nothing else: a default says
 * it is, and no default says the account does not work without it. Resolving to undefined and
 * carrying on is what produced a host nobody chose, an authentication failure naming neither the
 * setting nor the value, and an account that reported itself configured.
 *
 * An empty string counts as unset, because that is what a form submits for a field left alone.
 */
export function resolveRequiredSetting(
  setting: AccountSetting,
  stored: string | undefined,
): string {
  const value = stored?.trim();
  if (value) {
    if (setting.options && !setting.options.some((option) => option.value === value)) {
      throw new Error(
        `"${value}" is not a valid ${setting.label}. Known values: `
        + `${setting.options.map((option) => option.value).join(', ')}.`,
      );
    }
    return value;
  }
  if (setting.defaultValue) return setting.defaultValue;
  throw new Error(
    `${setting.label} is required and this account has not set it. A setting declared without a `
    + 'default cannot be left out.',
  );
}

/**
 * The effective value of one setting.
 *
 * A stored value wins; its absence takes the declared default. A stored value outside the options is
 * refused rather than passed along, because it would reach the request path, match no host, and fail
 * as an authentication error naming neither the value nor what was expected.
 */
export function resolveAccountSetting(
  vendor: string,
  key: string,
  stored: string | undefined,
): string | undefined {
  const setting = ACCOUNT_SETTINGS[vendor]?.find((entry) => entry.key === key);
  if (!setting) return stored;
  if (stored === undefined || stored === '') return setting.defaultValue;
  if (setting.options && !setting.options.some((option) => option.value === stored)) {
    throw new Error(
      `"${stored}" is not a known ${vendor} ${key}. Known values: `
      + `${setting.options.map((option) => option.value).join(', ')}.`,
    );
  }
  return stored;
}
