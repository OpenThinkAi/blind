// The check that bundled JavaScript has no Node-only code: shared by test/browser.test.ts (the browser
// entry bundled from source) and test/pack.test.ts (the packed package's browser entry bundled from
// node_modules). The TypeScript parser is used here, in tests, never by the library.
import ts from "typescript";

/** Globals a browser does not have. The identifier is reported wherever it is referenced, not where it is a property name. */
const NODE_GLOBALS = new Set(["Buffer", "process", "require", "__require", "Bun", "setImmediate", "__dirname", "__filename"]);

const isPropertyName = (node: ts.Identifier): boolean => {
  const p = node.parent;
  if (ts.isPropertyAccessExpression(p)) return p.name === node;
  if (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) return p.name === node;
  if (ts.isBindingElement(p)) return p.propertyName === node;
  return false;
};

/** Every Node-only thing in bundled JavaScript: a module specifier (any import, `node:` or `bun:` above all), a `node:`/`bun:` string, or a Node global. */
export function nodeOnly(code: string): string[] {
  const found: string[] = [];
  const sf = ts.createSourceFile("bundle.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(`import "${node.moduleSpecifier.text}"`);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found.push("import()");
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^(?:node:|bun:|bun$)/.test(node.text)) {
      found.push(`"${node.text}"`);
    } else if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text) && !isPropertyName(node)) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...new Set(found)];
}
