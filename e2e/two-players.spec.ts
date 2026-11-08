import { type Browser, type Page, expect, test } from "@playwright/test";

async function openPilot(browser: Browser, name: string, room: string, create: boolean): Promise<Page> {
  // Окремий контекст = окремі cookie/сховище: це справді різні гравці.
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  await page.goto("/");
  await page.mouse.click(500, 350); // перший жест користувача запускає гру (звук/boot)
  await page.getByLabel("Pilot call:").fill(name);
  if (create) {
    await page.getByPlaceholder("room name").fill(room);
    await page.getByRole("button", { name: "CREATE ROOM" }).click();
  }
  // Рядок кімнати з'являється після опитування списку (≤ 4 с).
  const row = page.locator("div", { hasText: room }).filter({ has: page.getByRole("button", { name: "JOIN" }) }).last();
  await row.getByRole("button", { name: "JOIN" }).click({ timeout: 10_000 });
  await page.waitForFunction(() => window.__dogfight?.game?.ready === true, undefined, { timeout: 10_000 });
  return page;
}

test("два гравці в одній кімнаті: склад, рух видно іншому за 500 мс, чат", async ({ browser }) => {
  const room = `e2e-${Date.now()}`;
  const alice = await openPilot(browser, "Alice", room, true);
  const bob = await openPilot(browser, "Bob", room, false);

  // 1. Обидва бачать обох у складі кімнати.
  for (const page of [alice, bob]) {
    await expect(page.getByText(/Alice/).first()).toBeVisible();
    await expect(page.getByText(/Bob/).first()).toBeVisible();
  }

  // 2. Рух Alice видно Bob-у не пізніше ніж за 500 мс після натискання.
  const aliceShip = await alice.evaluate(() => window.__dogfight?.game?.shipId ?? -1);
  expect(aliceShip).toBeGreaterThan(-1);
  const positionSeenByBob = (): Promise<{ x: number; y: number } | null> =>
    bob.evaluate((id) => {
      const scene = window.__dogfight?.game?.scene(1);
      const ship = scene?.entities.find((e) => e.id === id);
      return ship ? { x: ship.x, y: ship.y } : null;
    }, aliceShip);

  // Alice з'являється в сцені Bob-а з першим снапшотом після його входу.
  await expect.poll(async () => (await positionSeenByBob()) !== null, { timeout: 5000 }).toBe(true);
  const before = await positionSeenByBob();
  const pressedAt = Date.now();
  await alice.keyboard.down("ArrowUp");
  await expect
    .poll(
      async () => {
        const now = await positionSeenByBob();
        if (!now || !before) return 0;
        return Math.hypot(now.x - before.x, now.y - before.y);
      },
      { timeout: 500, intervals: [25, 25, 50] },
    )
    .toBeGreaterThan(0.5);
  const latency = Date.now() - pressedAt;
  await alice.keyboard.up("ArrowUp");
  expect(latency).toBeLessThanOrEqual(600); // 500 мс + похибка evaluate

  // 3. Чат: повідомлення Alice доходить до Bob-а.
  await alice.keyboard.press("Enter");
  await alice.getByPlaceholder("Enter — писати в чат").fill("привіт з e2e");
  await alice.keyboard.press("Enter");
  await expect(bob.getByText("привіт з e2e")).toBeVisible({ timeout: 2000 });

  await alice.context().close();
  await bob.context().close();
});

test("вихід гравця: склад оновлюється", async ({ browser }) => {
  const room = `e2e-leave-${Date.now()}`;
  const carol = await openPilot(browser, "Carol", room, true);
  const dave = await openPilot(browser, "Dave", room, false);
  await expect(carol.getByText(/Dave/).first()).toBeVisible();
  await dave.context().close();
  await expect(carol.getByText(/Dave/)).toHaveCount(0, { timeout: 5000 });
  await carol.context().close();
});
