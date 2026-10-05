export function createInput(target = window) {
  const down = new Set();
  const pressed = new Set();

  function onKeyDown(e) {
    if (!down.has(e.code)) {
      pressed.add(e.code);
    }
    down.add(e.code);
  }

  function onKeyUp(e) {
    down.delete(e.code);
  }

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    flush: () => pressed.clear(),
    destroy() {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
    },
  };
}
