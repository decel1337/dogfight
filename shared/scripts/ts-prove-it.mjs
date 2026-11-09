// Lab 06 «Prove it»: що TypeScript робить (і не робить) у рантаймі.
// Запуск: node --experimental-strip-types --disable-warning=ExperimentalWarning shared/scripts/ts-prove-it.mjs
// (tsc береться з node_modules, тому запускайте після `npm install`).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), "ts-prove-"));
const node = (file) =>
  spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      file,
    ],
    {
      encoding: "utf8",
    },
  );
const write = (name, text) => {
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return file;
};

// 1. Типи стираються: помилка типів не заважає виконанню.
const wrong = write(
  "wrong.ts",
  `
function add(a: number, b: number): number { return a + b; }
// @ts-expect-error — навмисно передаємо рядок
console.log(add("1", 2));
`,
);
console.log(
  "1. Node запускає код із помилкою типів:",
  JSON.stringify(node(wrong).stdout.trim()),
  "(рядок '12' замість 3)",
);

// 2. enum — не «стираний» синтаксис: Node відмовляється, erasableSyntaxOnly забороняє ще в tsc.
const enumFile = write(
  "enum.ts",
  `enum Kind { Ship = 1, Bullet = 2 }\nconsole.log(Kind.Ship);\n`,
);
const enumRun = node(enumFile);
console.log(
  "2. enum у Node:",
  enumRun.stderr
    .split("\n")
    .find((l) => l.includes("ERR_") || l.includes("TypeScript")) ??
    enumRun.stderr.slice(0, 120),
);

// 3. Той самий файл у tsc з erasableSyntaxOnly.
const require = createRequire(process.env.TOOLS ?? import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
try {
  execFileSync(
    process.execPath,
    [
      tsc,
      "--noEmit",
      "--ignoreConfig",
      "--erasableSyntaxOnly",
      "--target",
      "es2023",
      enumFile,
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
  console.log("3. tsc --erasableSyntaxOnly: прийняв (?!)");
} catch (error) {
  console.log(
    "3. tsc --erasableSyntaxOnly:",
    String(error.stdout).trim().split("\n")[0],
  );
}

// 4. Заміна: `as const`-об'єкт + union дає ті самі «імена» без enum і працює в Node.
const constObj = write(
  "kind.ts",
  `const KIND = { ship: 1, bullet: 2 } as const;\ntype Kind = (typeof KIND)[keyof typeof KIND];\nconst k: Kind = KIND.ship;\nconsole.log(k);\n`,
);
console.log("4. as const замість enum у Node:", node(constObj).stdout.trim());
