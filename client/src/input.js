const GAME_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
]);

// Замикання: стан клавіш приховано, назовні — лише методи.
// justPressed — подія «натиснуто з останнього кроку симуляції»; її
// очищає endStep() після кожного фіксованого кроку.
export function createInput(target) {
  const down = new Set();
  const pressed = new Set();

  // Друк у полі вводу (чат) не має керувати кораблем.
  const isTyping = (event) =>
    event.target instanceof HTMLElement &&
    (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA");

  const onKeyDown = (event) => {
    if (isTyping(event)) return;
    if (GAME_KEYS.has(event.code)) event.preventDefault();
    if (!down.has(event.code)) pressed.add(event.code);
    down.add(event.code);
  };
  const onKeyUp = (event) => {
    down.delete(event.code);
  };
  const onBlur = () => {
    down.clear();
  };

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  target.addEventListener("blur", onBlur);

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    endStep: () => pressed.clear(),
    dispose() {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("blur", onBlur);
    },
  };
}
