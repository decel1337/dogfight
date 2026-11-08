import { describe, expect, test } from "vitest";
import { Vector2, normalizeAngle } from "../src/sim/index.ts";

describe("Vector2", () => {
  test("add / sub / scale повертають нові вектори й не змінюють операнди", () => {
    const a = new Vector2(1, 2);
    const b = new Vector2(3, -4);
    expect(a.add(b)).toEqual(new Vector2(4, -2));
    expect(a.sub(b)).toEqual(new Vector2(-2, 6));
    expect(a.scale(3)).toEqual(new Vector2(3, 6));
    expect(a).toEqual(new Vector2(1, 2));
    expect(b).toEqual(new Vector2(3, -4));
  });

  test("length і dist: піфагорова трійка 3-4-5", () => {
    expect(new Vector2(3, 4).length()).toBe(5);
    expect(new Vector2(0, 0).dist(new Vector2(3, 4))).toBe(5);
  });

  test("normalize: одиничний вектор; нульовий не дає NaN", () => {
    expect(new Vector2(0, 10).normalize()).toEqual(new Vector2(0, 1));
    expect(new Vector2(0, 0).normalize()).toEqual(new Vector2(0, 0));
    expect(new Vector2(3, 4).normalize().length()).toBeCloseTo(1, 12);
  });

  test("rotate: чверть оберту переводить (1,0) у (0,1), довжина зберігається", () => {
    const r = new Vector2(1, 0).rotate(Math.PI / 2);
    expect(r.x).toBeCloseTo(0, 9);
    expect(r.y).toBeCloseTo(1, 9);
    expect(new Vector2(3, 4).rotate(1.234).length()).toBeCloseTo(5, 9);
  });

  test("rotate: регресія — локальні змінні не затіняють cos/sin", () => {
    // Колись було `const cos = cos(angle)` (використання до оголошення).
    expect(() => new Vector2(1, 1).rotate(0.5)).not.toThrow();
  });

  test("dot і lerp", () => {
    expect(new Vector2(1, 2).dot(new Vector2(3, 4))).toBe(11);
    expect(new Vector2(0, 0).lerp(new Vector2(10, 20), 0.25)).toEqual(new Vector2(2.5, 5));
  });

  test("fromAngle дає одиничний вектор у потрібному напрямку", () => {
    const v = Vector2.fromAngle(Math.PI);
    expect(v.x).toBeCloseTo(-1, 9);
    expect(v.y).toBeCloseTo(0, 9);
  });

  test("normalizeAngle: кратні 2π зводяться до нуля, діапазон [-π, π]", () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(Math.PI * 2)).toBeCloseTo(0, 12);
    expect(normalizeAngle(7)).toBeCloseTo(7 - Math.PI * 2, 12);
    expect(Math.abs(normalizeAngle(-100))).toBeLessThanOrEqual(Math.PI + 1e-12);
  });
});
