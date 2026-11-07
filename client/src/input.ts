const GAME_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
]);

export interface Input {
  isDown(code: string): boolean;
  justPressed(code: string): boolean;
  endStep(): void;
  dispose(): void;
}

// Замикання: стан клавіш приховано, назовні — лише методи.
// justPressed — подія «натиснуто з останнього кроку симуляції»; її
// очищає endStep() після кожного фіксованого кроку.
export function createInput(target: EventTarget): Input {
  const down = new Set<string>();
  const pressed = new Set<string>();

  // Друк у полі вводу (чат) не має керувати кораблем.
  const isTyping = (event: KeyboardEvent): boolean =>
    event.target instanceof HTMLElement &&
    (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA");

  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isTyping(event)) return;
    if (GAME_KEYS.has(event.code)) event.preventDefault();
    if (!down.has(event.code)) pressed.add(event.code);
    down.add(event.code);
  };
  const onKeyUp = (event: Event): void => {
    if (event instanceof KeyboardEvent) down.delete(event.code);
  };
  const onBlur = (): void => {
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
