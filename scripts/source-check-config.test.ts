import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSourceProfiles } from "./source-check-config.ts";

test("keeps browser and app-local aliases while detecting stale shared source mappings without writes", () => {
  const root = mkdtempSync(join(tmpdir(), "clash-source-profile-"));
  try {
    const base = {
      compilerOptions: {
        paths: {
          "@example/runtime": ["runtime/node.ts"],
          "@example/types": ["types/index.ts"],
        },
      },
    };
    writeFileSync(join(root, "tsconfig.source.json"), JSON.stringify(base));
    const profile = {
      file: "check.json",
      extends: ["./app.json", "./tsconfig.source.json"],
      aliases: { "@example/runtime": ["runtime/browser.ts"], "@/*": ["app/*"] },
    };
    writeFileSync(
      join(root, "source-check-profiles.json"),
      JSON.stringify([profile]),
    );
    assert.deepEqual(checkSourceProfiles(root), [profile.file]);
    checkSourceProfiles(root, true);
    const before = readFileSync(join(root, profile.file), "utf8");
    const generated = JSON.parse(before);
    assert.deepEqual(
      generated.compilerOptions.paths["@example/runtime"],
      profile.aliases["@example/runtime"],
    );
    assert.deepEqual(
      generated.compilerOptions.paths["@/*"],
      profile.aliases["@/*"],
    );
    assert.deepEqual(
      generated.compilerOptions.paths["@example/types"],
      base.compilerOptions.paths["@example/types"],
    );
    assert.deepEqual(checkSourceProfiles(root), []);
    base.compilerOptions.paths["@example/types"] = ["types/next.ts"];
    writeFileSync(join(root, "tsconfig.source.json"), JSON.stringify(base));
    assert.deepEqual(checkSourceProfiles(root), [profile.file]);
    assert.equal(readFileSync(join(root, profile.file), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
