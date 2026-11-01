// Головоломки порядку виконання (Node). Запуск: node scripts/puzzles.mjs
const out = [];
const log = (x) => out.push(x);
const flush = (title) => {
  console.log(`${title}: ${out.join(", ")}`);
  out.length = 0;
};
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// 1. await vs синхронний код
(async () => {
  log(1);
  await null;
  log(2);
})();
log(3);
await tick();
flush("Puzzle 1");

// 2. setTimeout усередині .then
Promise.resolve().then(() => {
  log("A");
  setTimeout(() => log("B"), 0);
});
setTimeout(() => log("C"), 0);
await tick();
flush("Puzzle 2");

// 3. async-функція та ланцюжок .then
async function a() {
  log("a1");
  await b();
  log("a2");
}
async function b() {
  log("b");
}
log("start");
a();
Promise.resolve()
  .then(() => log("p1"))
  .then(() => log("p2"));
log("end");
await tick();
flush("Puzzle 3");

// 4. Мікрозадачі виконуються після КОЖНОЇ макрозадачі
setTimeout(() => log("T1"), 0);
setTimeout(() => {
  log("T2");
  Promise.resolve().then(() => log("M-in-T2"));
}, 0);
setTimeout(() => log("T3"), 0);
await tick();
flush("Puzzle 4");
