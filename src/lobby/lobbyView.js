// Лише відображення: слухає події Lobby і викликає onJoin.
export function createLobbyView(lobby, { onJoin }) {
  const root = document.createElement("div");
  root.id = "lobby-overlay";
  root.style.cssText = [
    "position:fixed",
    "inset:0",
    "background:rgba(10,15,26,0.95)",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "color:#fff",
    "font-family:monospace",
    "z-index:100",
  ].join(";");

  const title = document.createElement("h2");
  title.textContent = "MISSION LOBBY";

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Pilot call: ";
  const nameInput = document.createElement("input");
  nameInput.value = "Ace";
  nameInput.maxLength = 16;
  nameLabel.append(nameInput);

  const status = document.createElement("div");
  status.textContent = "Завантаження секторів...";
  status.style.minHeight = "1.5em";

  const list = document.createElement("div");

  root.append(title, nameLabel, status, list);
  document.body.append(root);

  const onRooms = (event) => {
    status.textContent = "";
    list.replaceChildren(
      ...event.detail.map((room) => {
        const row = document.createElement("div");
        row.style.margin = "8px 0";

        // textContent, а не innerHTML: назва кімнати приходить з мережі.
        const label = document.createElement("span");
        label.textContent = `${room.name} (${room.maxPlayers} max)`;

        const button = document.createElement("button");
        button.textContent = "JOIN";
        button.style.marginLeft = "12px";
        button.addEventListener("click", () => {
          lobby.join(room.id, nameInput.value.trim() || "Ace");
        });

        row.append(label, button);
        return row;
      }),
    );
  };

  const onError = (event) => {
    status.textContent = `Помилка лобі: ${event.detail.message}. Повторюю...`;
  };

  const onJoined = (event) => {
    destroy();
    onJoin(event.detail);
  };

  function destroy() {
    lobby.removeEventListener("rooms", onRooms);
    lobby.removeEventListener("lobby-error", onError);
    lobby.removeEventListener("joined", onJoined);
    root.remove();
  }

  lobby.addEventListener("rooms", onRooms);
  lobby.addEventListener("lobby-error", onError);
  lobby.addEventListener("joined", onJoined);
  lobby.start();

  return { destroy };
}
