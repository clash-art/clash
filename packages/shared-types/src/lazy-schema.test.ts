import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  isLazyValueInitialized,
  lazySchema,
  lazyValue,
} from "./lazy-schema.js";

describe("lazyValue", () => {
  it("does not run the initializer until the first read, then runs it once", () => {
    let calls = 0;
    const value = lazyValue(() => {
      calls += 1;
      return { answer: 42 };
    });

    expect(calls).toBe(0);
    expect(isLazyValueInitialized(value)).toBe(false);
    expect(value.answer).toBe(42);
    expect(calls).toBe(1);
    expect(isLazyValueInitialized(value)).toBe(true);

    expect(value.answer).toBe(42);
    expect("answer" in value).toBe(true);
    expect(Object.keys(value)).toEqual(["answer"]);
    expect({ ...value }).toEqual({ answer: 42 });
    expect(calls).toBe(1);
  });

  it("forwards writes to the initialized value", () => {
    const value = lazyValue(() => ({ answer: 1 }));
    value.answer = 2;
    expect(value.answer).toBe(2);
  });

  it("propagates an initializer failure to the caller and does not leave a half-built value", () => {
    const failure = new Error("catalog is malformed");
    let calls = 0;
    const value = lazyValue<{ answer: number }>(() => {
      calls += 1;
      throw failure;
    });

    expect(() => value.answer).toThrow(failure);
    expect(isLazyValueInitialized(value)).toBe(false);
    expect(() => value.answer).toThrow(failure);
    expect(calls).toBe(2);
  });

  it("keeps array values arrays and forwards iteration", () => {
    const value = lazyValue(() => [1, 2, 3], []);
    expect(Array.isArray(value)).toBe(true);
    expect([...value]).toEqual([1, 2, 3]);
    expect(value.map((item) => item * 2)).toEqual([2, 4, 6]);
    expect(value.length).toBe(3);
  });
});

describe("lazySchema", () => {
  it("preserves parse results, error issues and instanceof", () => {
    const shape = { id: z.string(), count: z.number().int().positive() };
    const eager = z.object(shape);
    let constructions = 0;
    const lazy = lazySchema(() => {
      constructions += 1;
      return z.object(shape);
    });

    expect(constructions).toBe(0);
    expect(lazy instanceof z.ZodType).toBe(true);
    expect(constructions).toBe(1);
    expect(lazy.parse({ id: "a", count: 2 })).toEqual(
      eager.parse({ id: "a", count: 2 }),
    );

    let eagerError: unknown;
    let lazyError: unknown;
    try {
      eager.parse({ id: 1, count: 0 });
    } catch (error) {
      eagerError = error;
    }
    try {
      lazy.parse({ id: 1, count: 0 });
    } catch (error) {
      lazyError = error;
    }
    expect(lazyError).toBeInstanceOf(z.ZodError);
    expect((lazyError as z.ZodError).issues).toEqual(
      (eagerError as z.ZodError).issues,
    );
    expect((lazyError as Error).message).toBe((eagerError as Error).message);
    expect(constructions).toBe(1);
  });

  it("keeps shape access and derivation working", () => {
    const lazy = lazySchema(() =>
      z.object({ id: z.string(), count: z.number() }),
    );
    expect(Object.keys(lazy.shape)).toEqual(["id", "count"]);
    expect(lazy.extend({ extra: z.boolean() }).parse({ id: "a", count: 1, extra: true })).toEqual({
      id: "a",
      count: 1,
      extra: true,
    });
    expect(lazy.pick({ id: true }).parse({ id: "a" })).toEqual({ id: "a" });
  });

  it("projects nested lazy schemas to the same JSON Schema as eager ones", () => {
    const eager = z
      .object({
        id: z.string().describe("Stable id"),
        count: z.number().int().optional().describe("Optional count"),
        nested: z.array(z.object({ label: z.string().describe("Label") })),
      })
      .strict()
      .describe("Lazy parity");
    const id = lazySchema(() => z.string().describe("Stable id"));
    const count = lazySchema(() =>
      z.number().int().optional().describe("Optional count"),
    );
    const label = lazySchema(() => z.string().describe("Label"));
    const nested = lazySchema(() => z.array(z.object({ label })));
    const lazy = lazySchema(() =>
      z
        .object({ id, count, nested })
        .strict()
        .describe("Lazy parity"),
    );

    const options = { unrepresentable: "any" as const, io: "input" as const };
    expect(z.toJSONSchema(lazy, options)).toEqual(
      z.toJSONSchema(eager, options),
    );
  });

  it("exposes metadata registered inside the initializer through the proxy", () => {
    const lazy = lazySchema(() => z.string().describe("Label"));
    expect(lazy.description).toBe("Label");
    expect(z.globalRegistry.get(lazy)).toEqual({ description: "Label" });
    expect(z.globalRegistry.get(lazy)?.description).toBe("Label");
  });
});

describe("MODEL_CARDS", () => {
  it("validates the catalog on first access, not at module evaluation", async () => {
    vi.resetModules();
    const lazy = await import("./lazy-schema.js");
    const models = await import("./models.js");

    const catalogProxy = models.MODEL_CARDS;
    expect(lazy.isLazyValueInitialized(catalogProxy)).toBe(false);
    const cards = models.MODEL_CARDS;
    expect(cards.length).toBeGreaterThan(0);
    expect(lazy.isLazyValueInitialized(catalogProxy)).toBe(true);
    // The exported binding is swapped to the real catalog after first use.
    expect(models.MODEL_CARDS).not.toBe(catalogProxy);
    expect(Array.isArray(models.MODEL_CARDS)).toBe(true);
    expect(() => models.ModelCardSchema.parse(models.MODEL_CARDS[0])).not.toThrow();
    // The memoized catalog is the same value on later reads.
    expect(models.MODEL_CARDS[0]).toBe(models.MODEL_CARDS[0]);
  });

  it("fails the first access with the same zod error as eager validation for a malformed catalog", () => {
    const malformed = [{ id: 1, name: "not a catalog" }];
    const eager = z.array(z.unknown()).parse(malformed);
    const eagerValidation = z.array(
      z.object({ id: z.string(), name: z.string() }),
    );
    let eagerError: unknown;
    try {
      eagerValidation.parse(malformed);
    } catch (error) {
      eagerError = error;
    }

    const lazy = lazyValue(
      () =>
        z
          .array(z.object({ id: z.string(), name: z.string() }))
          .parse(eager),
      [],
    );
    let lazyError: unknown;
    try {
      lazy[0];
    } catch (error) {
      lazyError = error;
    }

    expect(lazyError).toBeInstanceOf(z.ZodError);
    expect((lazyError as z.ZodError).issues).toEqual(
      (eagerError as z.ZodError).issues,
    );
    expect((lazyError as Error).message).toBe((eagerError as Error).message);
    expect(isLazyValueInitialized(lazy)).toBe(false);
  });
});
