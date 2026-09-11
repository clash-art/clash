import { describe, expect, it } from "vitest";
import * as director from "./index";

// The source supplies the expected behavior: parameters and timeline time must
// reach independent uses of the same compiled component without captured props.
describe("Director single-file components", () => {
  it("reuses source while keeping parameters, time, and source revisions independent", () => {
    const compile = (director as any).compileDirectorCodeComponent;
    expect(compile).toBeTypeOf("function");
    const source = `
      import { MathUtils } from 'three';
      export default function Light({ parameters, timeSeconds }) {
        return <pointLight intensity={MathUtils.clamp(parameters.power + timeSeconds, 0, 100)} />;
      }
    `;
    const Component = compile(source);
    const first = Component({ parameters: { power: 3 }, timeSeconds: 2 });
    const second = Component({ parameters: { power: 8 }, timeSeconds: 2 });
    expect(first.props.intensity).toBe(5);
    expect(second.props.intensity).toBe(10);
    const revised = compile(
      source.replace("power + timeSeconds", "power * timeSeconds"),
    );
    expect(
      revised({ parameters: { power: 3 }, timeSeconds: 2 }).props.intensity,
    ).toBe(6);
    expect(
      Component({ parameters: { power: 3 }, timeSeconds: 2 }).props.intensity,
    ).toBe(5);
  });

  it("reports missing entrypoints, invalid TSX, and imports outside the single-file runtime", () => {
    const compile = (director as any).compileDirectorCodeComponent;
    expect(compile).toBeTypeOf("function");
    for (const source of [
      "export const notAnEntrypoint = 3;",
      "export default function Broken() { return <group; }",
      "import helper from './other-file'; export default () => helper();",
      "export default async () => import('three');",
    ])
      expect(() => compile(source)).toThrow();
  });
});
