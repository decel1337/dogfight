// Незалежна перевірка «no-floating-promises» через API компілятора TypeScript.
// Знаходить вирази-інструкції типу Promise, які не awaited, не void і не
// мають обробника (.catch / .then з двома аргументами). Той самий критерій,
// що в правилі ESLint; корисний, коли ESLint ще не встановлено.
// Запуск: node scripts/audit-floating-promises.mjs [tsconfig ...]
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(process.env.TOOLS ?? import.meta.url);
const ts = require("typescript");
const configs = process.argv.slice(2);
if (configs.length === 0) configs.push("shared/tsconfig.json", "server/tsconfig.json", "client/tsconfig.json");

let findings = 0;
for (const configPath of configs) {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.resolve(configPath), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => console.error(ts.flattenDiagnosticMessageText(d.messageText, "\n")),
  });
  if (!parsed) continue;
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const isThenable = (type) => {
    const then = type.getProperty("then");
    return Boolean(then);
  };
  const handled = (expr) =>
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ((expr.expression.name.text === "catch" && expr.arguments.length >= 1) ||
      (expr.expression.name.text === "then" && expr.arguments.length >= 2));
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || file.fileName.includes("node_modules")) continue;
    const visit = (node) => {
      if (ts.isExpressionStatement(node)) {
        const expr = node.expression;
        const skip = ts.isVoidExpression(expr) || ts.isAwaitExpression(expr) || ts.isBinaryExpression(expr);
        if (!skip && !handled(expr) && isThenable(checker.getTypeAtLocation(expr))) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart());
          console.log(`${path.relative(process.cwd(), file.fileName)}:${line + 1}: floating promise: ${node.getText().slice(0, 80)}`);
          findings++;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
}
console.log(findings === 0 ? "OK: плаваючих промісів немає" : `Знайдено: ${findings}`);
process.exit(findings === 0 ? 0 : 1);
