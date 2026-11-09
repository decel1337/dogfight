// Мінімальна інструментація: performance.measure з довільними початком/кінцем.
// Увімкнена лише з ?perf=1, тож у звичайній грі коштує одну перевірку булева.
// Ніяких замикань і рядкових конкатенацій на гарячому шляху: ім'я — константа,
// початок — число з performance.now().
export const PERF_ENABLED = new URLSearchParams(location.search).has("perf");

export type PerfName = "frame" | "scene" | "draw" | "snapshot" | "step";

export function perfBegin(): number {
  return PERF_ENABLED ? performance.now() : 0;
}

export function perfEnd(name: PerfName, start: number): void {
  if (PERF_ENABLED)
    performance.measure(name, { start, end: performance.now() });
}

if (PERF_ENABLED) performance.mark("dogfight:perf-enabled");
