import { HttpError } from "../assets/loader.ts";
import type { JoinDetail, Lobby, LobbyEventMap } from "./lobby.ts";

// Лише відображення: слухає події Lobby і викликає onJoin.
export function createLobbyView(
  lobby: Lobby,
  { onJoin }: { onJoin: (detail: JoinDetail) => void },
): { destroy(): void } {
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

  // Створення кімнати: POST /api/rooms.
  const createRow = document.createElement("div");
  createRow.style.margin = "12px 0";
  const roomName = document.createElement("input");
  roomName.placeholder = "room name";
  roomName.maxLength = 32;
  const createButton = document.createElement("button");
  createButton.textContent = "CREATE ROOM";
  createButton.style.marginLeft = "8px";
  createButton.addEventListener("click", async () => {
    createButton.disabled = true;
    try {
      await lobby.createRoom({ name: roomName.value.trim() || undefined });
      roomName.value = "";
    } catch (error: unknown) {
      const reason =
        error instanceof HttpError ? (error.detail ?? error.message) : error instanceof Error ? error.message : String(error);
      status.textContent = `Не вдалося створити кімнату: ${reason}`;
    } finally {
      createButton.disabled = false;
    }
  });
  createRow.append(roomName, createButton);

  const status = document.createElement("div");
  status.textContent = "Завантаження секторів...";
  status.style.minHeight = "1.5em";

  const list = document.createElement("div");

  root.append(title, nameLabel, createRow, status, list);
  document.body.append(root);

  const onRooms = (event: CustomEvent<LobbyEventMap["rooms"]>): void => {
    status.textContent = "";
    list.replaceChildren(
      ...event.detail.map((room) => {
        const row = document.createElement("div");
        row.style.margin = "8px 0";

        // textContent, а не innerHTML: назва кімнати приходить з мережі.
        const label = document.createElement("span");
        label.textContent = `${room.name} (${room.players ?? 0}/${room.maxPlayers})`;

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

  const onError = (event: CustomEvent<LobbyEventMap["lobby-error"]>): void => {
    status.textContent = `Помилка лобі: ${event.detail.message}. Повторюю...`;
  };

  const onJoined = (event: CustomEvent<LobbyEventMap["joined"]>): void => {
    destroy();
    onJoin(event.detail);
  };

  function destroy(): void {
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
