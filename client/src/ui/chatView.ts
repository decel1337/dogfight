// Панель кімнати: склад гравців, чат і статус з'єднання.
// Усе вставляється через textContent: імена й повідомлення приходять
// від інших гравців і не повинні потрапляти в HTML.

export interface ChatViewOptions {
  onSend: (text: string) => void;
  maxLength?: number;
}

export interface ChatView {
  setStatus(text: string): void;
  setRoster(players: readonly { readonly name: string }[]): void;
  addMessage(message: { from: string; text: string }): void;
  addSystem(text: string): void;
  destroy(): void;
}

export function createChatView({ onSend, maxLength = 200 }: ChatViewOptions): ChatView {
  const root = document.createElement("div");
  root.id = "chat-panel";
  root.style.cssText = [
    "position:fixed",
    "right:12px",
    "bottom:12px",
    "width:260px",
    "display:flex",
    "flex-direction:column",
    "gap:6px",
    "padding:8px",
    "background:rgba(13,17,23,0.85)",
    "border:1px solid #30363d",
    "color:#c9d1d9",
    "font:12px monospace",
    "z-index:50",
  ].join(";");

  const status = document.createElement("div");
  status.style.color = "#8b949e";

  const roster = document.createElement("div");
  roster.style.color = "#58a6ff";

  const log = document.createElement("div");
  log.style.cssText = "height:140px;overflow-y:auto;word-break:break-word";

  const input = document.createElement("input");
  input.placeholder = "Enter — писати в чат";
  input.maxLength = maxLength;
  input.style.cssText =
    "background:#0d1117;border:1px solid #30363d;color:#fff;padding:4px";

  root.append(status, roster, log, input);
  document.body.append(root);

  const submit = (): void => {
    const text = input.value.trim();
    if (text) onSend(text);
    input.value = "";
    input.blur(); // повертаємо клавіші керування кораблю
  };

  input.addEventListener("keydown", (event: KeyboardEvent) => {
    event.stopPropagation(); // WASD/Space у полі вводу не керують кораблем
    if (event.key === "Enter") submit();
    if (event.key === "Escape") input.blur();
  });

  // Enter поза полем вводу — перейти до чату.
  const onWindowKey = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && document.activeElement !== input) {
      event.preventDefault();
      input.focus();
    }
  };
  window.addEventListener("keydown", onWindowKey);

  return {
    setStatus(text: string): void {
      status.textContent = text;
    },
    setRoster(players: readonly { readonly name: string }[]): void {
      roster.textContent = `У кімнаті: ${players.map((p) => p.name).join(", ")}`;
    },
    addMessage({ from, text }: { from: string; text: string }): void {
      const line = document.createElement("div");
      const author = document.createElement("b");
      author.textContent = `${from}: `;
      line.append(author, document.createTextNode(text));
      log.append(line);
      log.scrollTop = log.scrollHeight;
      while (log.childElementCount > 100) log.firstChild?.remove();
    },
    addSystem(text: string): void {
      const line = document.createElement("div");
      line.style.color = "#8b949e";
      line.textContent = text;
      log.append(line);
      log.scrollTop = log.scrollHeight;
    },
    destroy(): void {
      window.removeEventListener("keydown", onWindowKey);
      root.remove();
    },
  };
}
