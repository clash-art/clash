import { describe, expect, it } from "vitest";

import {
  ProjectMetadataEnvelopeSchema,
  ProjectMetadataSchema,
} from "./project-metadata.js";

const metadata = {
  projectId: "project-1",
  name: "Draft",
  description: null,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:01:00.000Z",
  deletedAt: null,
};

describe("ProjectMetadataSchema", () => {
  it("keeps the mirrored contract separate from ownership and local state", () => {
    expect(ProjectMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(
      ProjectMetadataSchema.safeParse({ ...metadata, ownerId: "user-1" })
        .success,
    ).toBe(false);
  });

  it("wraps metadata in a versioned transport envelope", () => {
    expect(
      ProjectMetadataEnvelopeSchema.parse({
        schemaVersion: 1,
        metadata,
      }),
    ).toEqual({ schemaVersion: 1, metadata });
  });
});
