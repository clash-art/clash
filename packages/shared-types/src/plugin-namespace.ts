import { z } from "zod";

/**
 * A plugin id is `publisher.name`.
 *
 * The same shape VS Code settled on -- `ms-python.python`, `dbaeumer.vscode-eslint` -- and for the
 * same reason: the publisher segment is what makes two people's `google` plugin two plugins rather
 * than a collision. Ours are `clash.google` and `clash.minimax`.
 *
 * The version is not part of the id. An updated plugin is the same plugin, which is what lets a
 * route bound to `clash.google` keep working across an upgrade. It also means the id is an identity
 * and not a permission: whoever publishes the next version publishes under the same name, so what
 * an id is good for is telling two plugins apart, not deciding what one is allowed to do.
 */

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

export interface PluginIdParts {
  publisher: string;
  name: string;
}

export function parsePluginId(id: string): PluginIdParts {
  const parsed = pluginIdSchema.parse(id);
  const [publisher, name] = parsed.split(".");
  return { publisher: publisher!, name: name! };
}

export const pluginIdSchema = z.string().trim().superRefine((value, ctx) => {
  const segments = value.split(".");
  if (segments.length !== 2) {
    ctx.addIssue({
      code: "custom",
      message: segments.length < 2
        // A bare name says nothing about who ships it, and the first third party to publish one
        // would silently take over routes bound to ours.
        ? `Plugin id ${value} needs a publisher: write it as publisher.name, like clash.google.`
        // A deeper path invites a hierarchy nothing reads, and two spellings of one plugin.
        : `Plugin id ${value} has ${segments.length} segments; a plugin id is publisher.name.`,
    });
    return;
  }
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) {
      ctx.addIssue({
        code: "custom",
        message: `Plugin id segment ${JSON.stringify(segment)} must be lowercase letters, digits `
          + `and hyphens, starting with a letter or digit.`,
      });
    }
  }
});
