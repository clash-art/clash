import { z } from "zod";

/**
 * How a provider says what it needs to authenticate.
 *
 * There is no auth-type registry, because there is no closed set of auth types. One vendor signs
 * requests with an access-key pair; another wants a console token; Google accepts several
 * credential forms, and which one works depends on the surface. A registry
 * would need an entry per vendor, which means editing the host to add a provider.
 *
 * So the vendor declares its own shape and the host only stores what comes back, opaquely. What the
 * host has to understand is not what a credential *is* -- it is how to draw the form, when to wake
 * the plugin, and where to send the browser. Everything else is plugin code.
 */

/** A duration the host can act on: `60s`, `15m`, `12h`, `7d`. */
const DurationSchema = z.string().trim().regex(
  /^\d+(?:s|m|h|d)$/,
  "Write a duration like 60s, 15m, 12h or 7d.",
);

const StorageKeySchema = z.string().trim().min(1);

/**
 * Five kinds, which covered every vendor examined.
 *
 * They describe rendering, not meaning. `secret` says draw it masked and store it encrypted; it
 * does not say the value is an api key, because the host has no use for knowing that.
 */
export const PluginAuthFormItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("field"),
    key: StorageKeySchema,
    label: z.string().trim().min(1),
    secret: z.boolean().optional(),
    placeholder: z.string().optional(),
    /** Unset with no default means the account does not work until the user fills it in. */
    default: z.string().optional(),
  }).strict(),
  z.object({
    kind: z.literal("choice"),
    key: StorageKeySchema,
    label: z.string().trim().min(1),
    // A menu with nothing on it renders as a control the user cannot satisfy.
    options: z.array(z.object({
      value: z.string().trim().min(1),
      label: z.string().trim().min(1),
    })).nonempty(),
    default: z.string().optional(),
  }).strict(),
  z.object({
    kind: z.literal("button"),
    key: StorageKeySchema,
    label: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal("notice"),
    text: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal("display-code"),
    key: StorageKeySchema,
    label: z.string().trim().min(1),
  }).strict(),
]);

/**
 * Where the browser goes and how the answer comes back.
 *
 * PKCE, the `state` parameter, the port and the timeout are the host's. A plugin that had to
 * implement `state` correctly would eventually implement it incorrectly, and the failure is a
 * silent CSRF rather than an error.
 */
/**
 * Parameters the host owns and a declaration may not set.
 *
 * Setting `state` would replace the value the host is about to compare against, turning the CSRF
 * check into a comparison of a constant with itself. The others are the same kind of mistake:
 * `code_challenge` is derived from a verifier only the host holds, and `redirect_uri` names a port
 * chosen when the flow starts.
 */
const HOST_OWNED_PARAMS = [
  "state",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  // Declared as `clientId`, not smuggled through here, so one spelling reaches the request.
  "client_id",
  "client_secret",
];

export const PluginAuthFlowCredentialSchema = z.object({
  /**
   * Where the vendor left the credential once the flow finished.
   *
   * Without this the host gets as far as knowing the sign-in completed and then a person reads the
   * token out with devtools, which is not a product. A fragment never reaches a server, so that
   * case is only readable from a browser the host is driving -- which is also why a `scheme`
   * callback needs no OS-level protocol registration: watching the navigation is enough.
   */
  from: z.enum(["cookie", "query", "fragment", "localStorage"]),
  /** Its name there: a cookie name, a parameter name, a storage key. */
  name: z.string().trim().min(1),
  /** The store key to write it under. */
  storeAs: z.string().trim().min(1),
}).strict();

export const PluginAuthFlowSchema = z.object({
  // Opened in the user's browser. A plaintext address would carry the request, and anything echoed
  // back to it, in the clear.
  open: z.string().trim().url().refine(
    (value) => value.startsWith("https://"),
    "A browser flow must open an https address.",
  ),
  // The exchange carries the code, the verifier and the client secret. A plaintext endpoint puts
  // all three on the wire.
  tokenUrl: z.string().trim().url().refine(
    (value) => value.startsWith("https://"),
    "A token endpoint must be https.",
  ).optional(),
  /**
   * The OAuth client, declared by whoever registered it with the vendor.
   *
   * This identifies the *application* asking for authorization, not the user granting it. The token
   * it obtains represents the user's own access to their own resources -- which is why quota and
   * billing land on the user's project, not on this client, and why there is no reason for a user to
   * bring their own. What is shared is only the application's consent screen and its verification
   * status.
   *
   * It lives in the declaration because a client belongs to the party that registered it: Clash
   * registered the Google one, and an author writing a Notion Provider registers theirs with Notion.
   * First-party Providers are plugins we ship, so they take the same path as any other.
   *
   * Declaring it is not a privilege. A plugin runs unsandboxed with network access, so one intent on
   * sending a user somewhere could open a browser itself. What stays with the host is the part that
   * must not vary: PKCE, `state`, the loopback port, the timeout, and the exchange. The plugin never
   * handles the code or the token; it reads the token back from its store like any other value.
   */
  clientId: z.string().trim().min(1).optional(),
  /**
   * Present because vendors ask for it, not because it is secret.
   *
   * RFC 8252 states plainly that an installed application cannot keep one, which is why PKCE exists
   * and why it is the actual protection here.
   */
  clientSecret: z.string().trim().min(1).optional(),
  /** Vendor-specific: scope, access_type, prompt, audience. */
  params: z.record(z.string(), z.string()).optional(),
  callback: z.discriminatedUnion("type", [
    /** Binds 127.0.0.1 on a random port. Google requires this for desktop clients; the
     * out-of-band flow was withdrawn in 2022. */
    z.object({ type: z.literal("loopback") }).strict(),
    /** A custom URL scheme, where that is the platform convention. */
    z.object({ type: z.literal("scheme"), scheme: z.string().trim().min(1) }).strict(),
    /** Device-code: show a code, poll until the user finishes elsewhere. */
    z.object({
      type: z.literal("poll-until"),
      url: z.string().trim().url(),
      intervalMs: z.number().int().positive().optional(),
    }).strict(),
  ]),
  credential: PluginAuthFlowCredentialSchema.optional(),
}).strict().superRefine((flow, ctx) => {
  // An authorization code is worth nothing without somewhere to exchange it. Without this a flow
  // opens a browser, collects a code, and stops.
  if (flow.clientId && !flow.tokenUrl) {
    ctx.addIssue({
      code: "custom",
      message: "A flow declaring a clientId must declare the tokenUrl that exchanges the code.",
    });
  }
  for (const key of Object.keys(flow.params ?? {})) {
    if (HOST_OWNED_PARAMS.includes(key)) {
      ctx.addIssue({
        code: "custom",
        message: `${key} is set by the host and must not be declared.`,
        path: ["params", key],
      });
    }
  }
});

/**
 * When the host should wake the plugin to renew.
 *
 * Only these two, because only these two need the host: it is the one awake when nobody is using
 * the app. A credential rejected *during* a call is not in this category -- the plugin is already
 * running, already holds the response, and can refresh and retry in the same function. Declaring
 * that case would mean reporting a failure outward and waiting to be called again, to do something
 * the plugin could have done immediately.
 */
export const PluginAuthRenewSchema = z.union([
  z.object({ before: DurationSchema }).strict(),
  z.object({ every: DurationSchema }).strict(),
]);

/**
 * One way of authenticating: a whole configuration, not a field.
 *
 * The declaration used to be a single flat form, and the ways of authenticating had to be
 * reconstructed from it -- `oneOf` to say two keys were alternatives, a `when` condition to hide a
 * field once another was filled. Both were the host inferring a structure the plugin knows
 * outright.
 *
 * Google is the case that broke that. A service account needs only its JSON; an API key
 * additionally needs to say which surface it addresses, because a key works on AI Studio *and* on
 * Agent Platform in Express mode. As loose fields there is no way to say that `service` belongs to
 * one method and not the other, which is why a cross-field condition appeared -- and before it, a
 * notice wrongly claiming Agent Platform refuses API keys.
 *
 * The host learns nothing about meaning here. It does not know `apiKey` is an API key or that
 * `serviceAccountKey` is JSON; they are a secret field and a secret field. Host logic keyed on
 * those names would be the host guessing at something the plugin never told it.
 */
/**
 * Reading a credential an installed local app already holds.
 *
 * A third way a method obtains one, beside a form the user fills and a flow the host drives. Some
 * vendors ship a desktop app and the user is already signed in to it; hrhrng.hub is one, and this
 * is why it worked before the method was dropped during a conversion.
 *
 * The recipe names the format, so the host never sniffs. Sniffing means guessing at another app's
 * storage, and guessing wrong yields plausible bytes rather than an error.
 *
 * None of this is a sandbox. The plugin sandbox was removed deliberately and a plugin can read any
 * file its user can; the constraint below only catches a declaration that reaches somewhere it
 * plainly did not mean to.
 */
export const PluginAuthImportSchema = z.object({
  format: z.literal("electron-store-aes-256-gcm-v2"),
  /** A subdirectory of the user's application data, not an arbitrary path. */
  appDataSubdirectory: z.string().trim().min(1)
    .refine((value) => !value.startsWith("/") && !value.startsWith("~") && !value.includes(".."), {
      message: "appDataSubdirectory must sit inside the application data directory.",
    }),
  configFile: z.string().trim().min(1),
  keyFile: z.string().trim().min(1),
  /** Where the value sits inside the config. Empty would read the whole object, which is not a
   * credential and would be stored as one. */
  tokenPath: z.array(z.string().trim().min(1)).min(1),
  /** The store key to write it under. */
  storeAs: z.string().trim().min(1),
}).strict();

export const PluginAuthMethodSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  form: z.array(PluginAuthFormItemSchema).optional(),
  flow: PluginAuthFlowSchema.optional(),
  import: PluginAuthImportSchema.optional(),
  renew: PluginAuthRenewSchema.optional(),
}).strict().refine(
  (method) => (method.form?.length ?? 0) > 0 || method.flow !== undefined
    || method.import !== undefined,
  // A method with none of the three offers the user a name and nothing to do with it.
  { message: "An auth method must collect something, start a flow, or import a credential." },
);

export const PluginAuthDeclarationSchema = z.object({
  methods: z.array(PluginAuthMethodSchema).min(1),
}).strict().superRefine((declaration, ctx) => {
  const seen = new Set<string>();
  for (const method of declaration.methods) {
    // The account records which method it uses by id, so a duplicate makes that record ambiguous.
    if (seen.has(method.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["methods"],
        message: `Two auth methods share the id ${method.id}.`,
      });
    }
    seen.add(method.id);
  }
});

export type PluginAuthMethod = z.infer<typeof PluginAuthMethodSchema>;

export type PluginAuthDeclaration = z.infer<typeof PluginAuthDeclarationSchema>;
export type PluginAuthFormItem = z.infer<typeof PluginAuthFormItemSchema>;
export type PluginAuthFlow = z.infer<typeof PluginAuthFlowSchema>;

// `requiredAuthKeys(declaration)` used to live here, returning every key across the whole form that
// declared no default. Under `methods` that question has no answer: the methods are alternatives, so
// the union of their required keys describes a configuration nobody can satisfy -- an account needs
// an apiKey OR a serviceAccountKey, and a list demanding both is simply false. `missingAuthKeys`
// answers the real question and answers it per method, which is the only scope where it means
// anything.
