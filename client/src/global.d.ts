import type { NetGame } from "./game/netgame.ts";
import type { Connection } from "./net/connection.ts";

// Діагностичний вхід для тестів і консолі браузера (див. main.ts).
declare global {
  interface Window {
    __dogfight?: {
      readonly game: NetGame | null;
      conn: Connection;
      settings: object;
    };
  }
}

// Vite підставляє import.meta.env.PROD під час збірки (true у `vite build`).
declare global {
  interface ImportMeta {
    readonly env: { readonly PROD: boolean };
  }
}
