// Протокол v1 — ЄДИНЕ джерело правди про повідомлення. Усі типи виводяться
// зі zod-схем (`z.infer`), тож схема й тип не можуть розійтися, а сервер і
// клієнт розбирають однаково.
//
//  керування (завжди JSON, текстові кадри):
//    клієнт -> сервер  join {room, name, codec?}   chat {text}   net {latency, jitter, drop}
//    сервер -> клієнт  joined {...}   roster {players}   chat {...}   error {message}
//
//  ігрові (кодек JSON або бінарний — обирається в join):
//    клієнт -> сервер  input {seq, tick, thrust, turn, fire}   ping {t}
//    сервер -> клієнт  snapshot {tick, ack, entities}   events {tick, events}   pong {t, tick}
//
// У JSON кожне повідомлення має поле `v` (версію) і `type`.
// Типи не існують у runtime, тому КОЖЕН вхід перевіряється схемою.
import { z } from "zod";
import { entityId, playerId } from "../types.ts";

export const PROTOCOL_VERSION = 1;

// Коди закриття: 1000–1015 стандартні (RFC 6455), 4000–4999 — прикладні.
export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  UNSUPPORTED: 1003,
  TOO_BIG: 1009,
  JOIN_TIMEOUT: 4001,
  INVALID_MESSAGE: 4002,
  RATE_LIMITED: 4003,
  ROOM_NOT_FOUND: 4004,
  ROOM_FULL: 4005,
  SLOW_CLIENT: 4006,
} as const;

export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

export const MAX_CHAT_LENGTH = 200;
export const ROOM_ID_RE = /^[\w-]{1,32}$/;
const NAME_RE = /^[\p{L}\p{N} _.-]{1,16}$/u;

export const CODECS = ["binary", "json"] as const;
export type CodecName = (typeof CODECS)[number];
export const DEFAULT_CODEC: CodecName = "binary";

// ---------- будівельні блоки схем ----------

const u32 = z.number().int().min(0).max(0xffffffff);
const u16 = z.number().int().min(0).max(0xffff);
const finite = z.number().finite();

const EntityIdSchema = u16.transform(entityId);
const PlayerIdSchema = u16.transform(playerId);

const ArenaSchema = z.object({
  width: z.number().positive().max(10_000),
  height: z.number().positive().max(10_000),
});

export const EntityRecordSchema = z.object({
  id: EntityIdSchema,
  kind: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  flags: z.number().int().min(0).max(0xff),
  x: finite,
  y: finite,
  vx: finite,
  vy: finite,
  angle: finite,
  a: finite,
  b: finite,
  c: finite,
});

const PlayerSchema = z.object({ id: PlayerIdSchema, name: z.string() });

// ---------- клієнт -> сервер ----------

export const InputSchema = z.object({
  type: z.literal("input"),
  seq: u32,
  tick: u32,
  // Літеральні union-и замість «число від -1 до 1»: turn: 1000 — це чит.
  thrust: z.union([z.literal(0), z.literal(1)]),
  turn: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  fire: z.union([z.literal(0), z.literal(1), z.literal(2)]),
});

export const PingSchema = z.object({ type: z.literal("ping"), t: u32 });

const JoinSchema = z.object({
  type: z.literal("join"),
  room: z.string().regex(ROOM_ID_RE, "очікується ідентифікатор кімнати"),
  name: z
    .string()
    .trim()
    .regex(NAME_RE, "1–16 літер, цифр, пробіл _ . -"),
  codec: z.enum(CODECS).default(DEFAULT_CODEC),
});

const ChatSendSchema = z.object({
  type: z.literal("chat"),
  text: z.string().trim().min(1).max(MAX_CHAT_LENGTH),
});

// Налаштування імітації мережі для ЦЬОГО з'єднання (латентність — RTT, мс).
const NetSchema = z.object({
  type: z.literal("net"),
  latency: z.number().min(0).max(2000),
  jitter: z.number().min(0).max(1000),
  drop: z.number().min(0).max(100),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  JoinSchema,
  ChatSendSchema,
  NetSchema,
  InputSchema,
  PingSchema,
]);

// ---------- сервер -> клієнт ----------

const RoomSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  players: z.number().int(),
  maxPlayers: z.number().int(),
  arena: ArenaSchema,
});

const JoinedSchema = z.object({
  type: z.literal("joined"),
  you: PlayerSchema,
  room: RoomSummarySchema,
  ship: EntityIdSchema,
  seed: u32,
  tickRate: z.number().int().positive(),
  tick: u32,
  arena: ArenaSchema,
  codec: z.enum(CODECS),
  netsim: z.boolean(),
});

const RosterSchema = z.object({
  type: z.literal("roster"),
  players: z.array(PlayerSchema),
});

const ChatBroadcastSchema = z.object({
  type: z.literal("chat"),
  from: z.string(),
  fromId: PlayerIdSchema,
  text: z.string(),
  t: z.number(),
});

const ErrorSchema = z.object({ type: z.literal("error"), message: z.string() });

export const SnapshotSchema = z.object({
  type: z.literal("snapshot"),
  tick: u32,
  ack: u32,
  entities: z.array(EntityRecordSchema),
});

export const GameEventSchema = z.object({
  kind: z.union([z.literal(1), z.literal(2), z.literal(3)]), // fired|hit|exploded
  id: EntityIdSchema,
  x: finite,
  y: finite,
});

export const EventsSchema = z.object({
  type: z.literal("events"),
  tick: u32,
  events: z.array(GameEventSchema),
});

export const PongSchema = z.object({
  type: z.literal("pong"),
  t: u32,
  tick: u32,
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  JoinedSchema,
  RosterSchema,
  ChatBroadcastSchema,
  ErrorSchema,
  SnapshotSchema,
  EventsSchema,
  PongSchema,
]);

// ---------- типи, виведені зі схем ----------

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type InputMessage = z.infer<typeof InputSchema>;
export type PingMessage = z.infer<typeof PingSchema>;
export type SnapshotMessage = z.infer<typeof SnapshotSchema>;
export type EventsMessage = z.infer<typeof EventsSchema>;
export type PongMessage = z.infer<typeof PongSchema>;
export type GameEvent = z.infer<typeof GameEventSchema>;
export type JoinedMessage = Extract<ServerMessage, { type: "joined" }>;

// Повідомлення, які ходять через кодек (бінарний або JSON).
export type ClientGameMessage = InputMessage | PingMessage;
export type ServerGameMessage = SnapshotMessage | EventsMessage | PongMessage;
export type GameMessage = ClientGameMessage | ServerGameMessage;

// ---------- розбір ----------

export type ParseResult<T> =
  | { readonly ok: true; readonly msg: T }
  | { readonly ok: false; readonly code: CloseCode; readonly reason: string };

const bad = (reason: string): { ok: false; code: CloseCode; reason: string } => ({
  ok: false,
  code: CLOSE.INVALID_MESSAGE,
  reason,
});

export function describeIssues(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "некоректне повідомлення";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

// Розбір JSON-тексту з конвертом {v, type, ...}. Не кидає винятків:
// результат — або повідомлення, або причина відмови.
function parseEnvelope<S extends z.ZodTypeAny>(
  text: string,
  schema: S,
): ParseResult<z.infer<S>> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return bad("некоректний JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return bad("очікується об'єкт");
  }
  const version: unknown = Reflect.get(json, "v");
  if (version !== PROTOCOL_VERSION) {
    return bad(`непідтримувана версія протоколу: ${String(version).slice(0, 16)}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return bad(describeIssues(parsed.error));
  return { ok: true, msg: parsed.data };
}

// Перевіряємо КОЖНЕ вхідне текстове повідомлення клієнта: клієнт — це
// недовірене джерело, навіть якщо ми самі його написали. НЕ кидає винятків.
export function parseClientMessage(
  raw: string | Uint8Array,
  { maxBytes }: { maxBytes: number },
): ParseResult<ClientMessage> {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw).length : raw.length;
  if (bytes > maxBytes) {
    return { ok: false, code: CLOSE.TOO_BIG, reason: "повідомлення завелике" };
  }
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  return parseEnvelope(text, ClientMessageSchema);
}

// Розбір повідомлення сервера на клієнті. Сервера теж не довіряємо:
// null для всього, що не схоже на повідомлення протоколу.
export function decodeServerJson(raw: string): ServerMessage | null {
  const result = parseEnvelope(raw, ServerMessageSchema);
  return result.ok ? result.msg : null;
}

// Серіалізація повідомлення сервера: додає версію.
export function encode(message: ServerMessage | ClientMessage): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...message });
}
