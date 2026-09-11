import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as THREE from "three";
import ts from "typescript";

export type DirectorCodeProps = {
  parameters: Record<string, unknown>;
  timeSeconds: number;
};
type Component = React.ComponentType<DirectorCodeProps>;
const modules: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  three: THREE,
};
const cache = new Map<string, Component>();
export const DirectorCodeSourcesContext = React.createContext<
  Record<string, string>
>({});

/** Trusted authored TSX, like inline Remotion. Import checks are a single-file
 * contract, not a security sandbox. Never evaluate source in the Node Host. */
export function compileDirectorCodeComponent(source: string): Component {
  const previous = cache.get(source);
  if (previous) return previous;
  const file = ts.createSourceFile(
    "DirectorComponent.tsx",
    source,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TSX,
  );
  const checkImport = (name: string) => {
    if (name !== "react" && name !== "three")
      throw new Error(
        `Director TSX imports only react or three; received ${name}`,
      );
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      if (!ts.isStringLiteralLike(node.moduleSpecifier))
        throw new Error("Director import must be a literal");
      checkImport(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node))
      throw new Error("Use ES imports in Director TSX");
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    )
      checkImport(node.argument.literal.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      throw new Error(
        "Dynamic imports and require are unavailable in single-file Director TSX",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const compiled = ts.transpileModule(source, {
    fileName: "DirectorComponent.tsx",
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      isolatedModules: true,
    },
  });
  const diagnostics =
    compiled.diagnostics?.filter(
      (item) => item.category === ts.DiagnosticCategory.Error,
    ) ?? [];
  if (diagnostics.length)
    throw new Error(
      diagnostics
        .map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))
        .join("\n"),
    );
  const module = { exports: {} as Record<string, unknown> };
  const requireModule = (name: string) => {
    if (!Object.hasOwn(modules, name))
      throw new Error(`Unsupported Director runtime import ${name}`);
    return modules[name];
  };
  new Function(
    "require",
    "module",
    "exports",
    `${compiled.outputText}\n//# sourceURL=DirectorComponent.tsx`,
  )(requireModule, module, module.exports);
  const component = module.exports.default;
  if (typeof component !== "function")
    throw new Error("Director TSX must default-export a component function");
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(source, component as Component);
  return component as Component;
}

export function DirectorCodeObject({
  source,
  parameters,
  timeSeconds,
}: DirectorCodeProps & { source: string }) {
  const Component = compileDirectorCodeComponent(source);
  return <Component parameters={parameters} timeSeconds={timeSeconds} />;
}

export function DirectorCodeInstance({
  componentId,
  ...props
}: DirectorCodeProps & { componentId: string }) {
  const sources = React.useContext(DirectorCodeSourcesContext);
  const source = sources[componentId];
  if (typeof source !== "string")
    throw new Error(`Director code source ${componentId} is unavailable`);
  return <DirectorCodeObject source={source} {...props} />;
}

export class DirectorCodeRenderBoundary extends React.Component<
  {
    children: React.ReactNode;
    revision: unknown;
    sources: unknown;
    onError: (error: Error | null) => void;
  },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  componentDidUpdate(previous: Readonly<DirectorCodeRenderBoundary["props"]>) {
    if (
      this.state.error &&
      (previous.revision !== this.props.revision ||
        previous.sources !== this.props.sources)
    ) {
      this.props.onError(null);
      this.setState({ error: null });
    }
  }
  render() {
    return this.state.error ? (
      <div role="alert">
        Director component error: {this.state.error.message}
      </div>
    ) : (
      this.props.children
    );
  }
}
