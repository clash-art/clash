import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";

import type {
  PluginAuthDeclaration,
  PluginAuthFormItem,
} from "./plugin-auth.js";

/**
 * Credential sources, normalized.
 *
 * A provider's auth declaration answers one question -- how does a credential for
 * this provider get here -- and consumers need two distinctions from the answer:
 *
 *   - which control renders it: a field, a button that opens a window, or a button
 *     that calls the host
 *   - whether it needs a human present, which is what decides if a headless or CI
 *     caller can use it at all
 *
 * That second axis is the one Kubernetes standardized as `interactiveMode` on exec
 * credential plugins, and it is the axis this product was missing: a provider whose
 * only route to a credential is a browser window has no unattended path, which used
 * to be invisible until a CLI run failed.
 *
 * What changed is where the distinctions come from. They used to be read off a union
 * over auth *types* -- `api-key`, `oauth`, `derived-token`, `local-token-import` --
 * and each new vendor needed a new member, which meant editing the host to add a
 * provider. One vendor signs each request with an access key and a secret, another wants a
 * token copied from a console, and Google accepts several credential forms; none
 * of them is a type the host should have to learn.
 *
 * The declaration already carries both distinctions without naming any of that. A
 * form item's `kind` says which control to draw, and the presence of a `flow` says a
 * browser window is involved. So this file now reads the declaration rather than
 * classifying vendors, and a new vendor is a new declaration rather than a new host
 * release.
 */

/** How a credential source is presented. */
export type CredentialSourceControl = "field" | "button-window" | "button-action";

/**
 * What kind of control a form item renders as.
 *
 * These are the declaration's own form kinds, not a taxonomy of vendors. `choice` is
 * a field with a fixed menu -- the region and service settings that used to be host
 * columns -- and renders as one.
 */
export let CredentialSourceKindSchema = lazySchema(() => (
z.enum([
  "field",
  "choice",
  "button",
  "display-code",
])
), (real) => { CredentialSourceKindSchema = real; });
export type CredentialSourceKind = z.infer<typeof CredentialSourceKindSchema>;

export interface CredentialSource {
  /** Storage key this source populates. Stable within its provider. */
  id: string;
  kind: CredentialSourceKind;
  label: string;
  control: CredentialSourceControl;
  /**
   * True when a human has to be present. A headless or CI caller must filter these
   * out rather than discover the failure by trying.
   */
  interactive: boolean;
  /** Storage key this source populates; the same value as `id`, named for its use. */
  credentialId: string;
  /** The complete authentication method that owns this source. */
  methodId: string;
  /**
   * True when the value must be stored encrypted and drawn masked.
   *
   * Replaces the old `derivesCredential`, which asked whether the stored secret could
   * be sent as-is. The host no longer has an opinion on that: it stores opaque values
   * and the plugin decides what to do with them, so there is nothing here for host
   * code to get wrong about a signing key. What is left is a rendering and storage
   * fact the host does own.
   *
   * Nothing in this type holds a value. A resolved source describes how a credential
   * is obtained and never carries the result, so code cannot persist a minted token
   * into a slot that does not exist -- which matters because poll state lives beside
   * the node in the canvas document, where a bearer token would be replicated and
   * backed up with the project long after it stopped working.
   */
  secret: boolean;
  /** The originating form item, when the method obtains the value from a form. */
  item?: PluginAuthFormItem;
}

/**
 * One uniform list of the ways a credential for this provider can be obtained.
 *
 * Order is preserved, so a provider controls which source it presents first, and
 * duplicates of a kind are kept -- two regions or two keys are two sources, not one
 * overwriting the other. `notice` items are dropped: they explain a field rather than
 * carrying a value, so they are presentation with no credential behind them.
 *
 * A `button` is reported as `button-window` when the declaration carries a `flow`,
 * and `button-action` otherwise. That is the whole of what the old five-member
 * taxonomy decided, now read from the declaration instead of from a vendor's name.
 */
export function resolveCredentialSources(
  declaration: PluginAuthDeclaration | undefined,
): CredentialSource[] {
  if (!declaration) return [];
  const sources: CredentialSource[] = [];
  // Each method carries its own form and its own flow, and the flow consulted for a button is the
  // one declared beside it. The old flat shape could not express that: there was a single `flow`
  // for the whole declaration, so a button in one part of the form was reported as opening a window
  // on the strength of a flow declared for an entirely different way of signing in.
  for (const method of declaration.methods) {
    const opensWindow = method.flow !== undefined;
    let flowHasDeclaredButton = false;
    for (const item of method.form ?? []) {
      if (item.kind === "notice") continue;
      if (item.kind === "button" && method.flow) {
        flowHasDeclaredButton = true;
      }
      const control: CredentialSourceControl = item.kind === "button"
        ? (opensWindow ? "button-window" : "button-action")
        : "field";
      sources.push({
        id: item.key,
        kind: item.kind,
        label: item.label,
        control,
        // Only a window needs someone at the keyboard. A typed key needs a human once,
        // but it can be provisioned ahead of time, so an unattended caller is not
        // blocked by it; a button that calls the host needs nobody at all.
        interactive: control === "button-window",
        credentialId: item.key,
        methodId: method.id,
        secret: item.kind === "field" ? item.secret === true : false,
        item,
      });
    }

    // A method is a whole way to obtain credentials. Flow-only and import-only methods deliberately
    // have no form: the user either signs in or asks the Host to reuse an installed app's login.
    // Dropping them because there is no form field makes the Provider's two easiest paths invisible.
    if (method.flow && !flowHasDeclaredButton) {
      const credentialId = method.flow.credential?.storeAs ?? method.id;
      sources.push({
        id: credentialId,
        kind: "button",
        label: method.label,
        control: "button-window",
        interactive: true,
        credentialId,
        methodId: method.id,
        secret: true,
      });
    }
    if (method.import) {
      sources.push({
        id: method.import.storeAs,
        kind: "button",
        label: method.label,
        control: "button-action",
        interactive: false,
        credentialId: method.import.storeAs,
        methodId: method.id,
        secret: true,
      });
    }
  }
  return sources;
}

/** Sources usable without a human present. */
export function unattendedCredentialSources(
  declaration: PluginAuthDeclaration | undefined,
): CredentialSource[] {
  return resolveCredentialSources(declaration).filter((source) => !source.interactive);
}

/** True when the provider can be configured without a human present. */
export function hasUnattendedCredentialSource(
  declaration: PluginAuthDeclaration | undefined,
): boolean {
  return unattendedCredentialSources(declaration).length > 0;
}
