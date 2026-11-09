// Повноекранне повідомлення про втрату сервера з кнопкою повернення в лобі.
// Жодних «вічних спінерів»: гравець завжди бачить, що сталося і що робити.
export interface NoticeHandle {
  remove(): void;
}

export function showServerNotice(
  message: string,
  onBack: () => void,
): NoticeHandle {
  document.getElementById("server-notice")?.remove();
  const root = document.createElement("div");
  root.id = "server-notice";
  root.setAttribute("role", "alertdialog");
  root.style.cssText = [
    "position:fixed",
    "inset:0",
    "background:rgba(10,15,26,0.92)",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "gap:16px",
    "color:#fff",
    "font-family:monospace",
    "z-index:200",
    "text-align:center",
    "padding:0 16px",
  ].join(";");
  const text = document.createElement("div");
  text.textContent = message;
  text.style.fontSize = "18px";
  const button = document.createElement("button");
  button.textContent = "ПОВЕРНУТИСЬ У ЛОБІ";
  button.addEventListener("click", onBack);
  root.append(text, button);
  document.body.append(root);
  return { remove: () => root.remove() };
}

// Фіксована позначка версії в кутку (git SHA із /health).
export async function showVersionStamp(): Promise<void> {
  try {
    const res = await fetch("/health", { cache: "no-store" });
    if (!res.ok) return;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return;
    const { version, sha } = body as { version?: unknown; sha?: unknown };
    if (typeof version !== "string" || typeof sha !== "string") return;
    const el = document.createElement("div");
    el.id = "version-stamp";
    el.textContent = `v${version} · ${sha.slice(0, 7)}`;
    el.style.cssText =
      "position:fixed;right:8px;bottom:6px;font:11px monospace;color:#8b949e;opacity:.8;z-index:50;pointer-events:none";
    document.body.append(el);
  } catch {
    // Позначка версії — другорядна: без мережі просто не показуємо.
  }
}
