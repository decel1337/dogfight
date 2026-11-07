import type { Connection } from "./net/connection.ts";
import type { NetGame } from "./game/netgame.ts";

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
