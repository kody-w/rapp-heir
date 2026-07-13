import { expect, test } from "@playwright/test";

async function questEventCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(async () => {
    return new Promise<number>((resolve, reject) => {
      const request = indexedDB.open("rapp-heir");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("events", "readonly");
        const all = transaction.objectStore("events").getAll();
        all.onerror = () => reject(all.error);
        all.onsuccess = () => {
          const count = (all.result as Array<{ body?: { type?: string } }>).filter(
            (event) => event.body?.type === "quest.created",
          ).length;
          db.close();
          resolve(count);
        };
      };
    });
  });
}

test("verified Pyodide QuestMaster reaches Review and sign before one atomic commit", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("./");
  await page.locator('input[name="name"]').fill("Browser Fern");
  await page.locator('input[name="color"]').fill("#6f62d8");
  await page.locator('select[name="temperament"]').selectOption("curious");
  await page.locator('input[name="voiceSeed"]').fill("quiet browser");
  await page.getByRole("button", { name: "Create companion on this device" }).click();
  await expect(page).toHaveURL(/#\/circles$/u);

  await page.locator("#offline-demo").click();
  await expect(page).toHaveURL(/#\/circle\/circle_/u);
  await page.getByRole("link", { name: /Ask the Pocket GM/u }).click();
  await expect(page).toHaveURL(/#\/play\/circle_/u);

  await page.locator('[data-orb-petal][data-action="mind"]').click();
  await page.locator("#confirm-highlight").click();
  await expect(page.locator("#verified-agent-form")).toBeVisible();

  expect(await questEventCount(page)).toBe(0);
  await page
    .locator("#verified-agent-form")
    .getByRole("button", { name: "Run hash-pinned QuestMaster" })
    .click();

  const cell = page.locator(
    'iframe[title="Verified local RAPP agent bytecode cell"]',
  );
  await expect(cell).toHaveAttribute("sandbox", "allow-scripts");

  await expect(page.locator("#agent-preview-title")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".agent-preview-card")).toContainText(
    "Manifest + source verified",
  );
  await expect(page.locator(".agent-preview-card")).toContainText(
    /offline-bundled-agent/u,
  );

  await page.locator("#stage-agent-quest").click();
  await expect(page.locator("#proposal-title")).toBeVisible();
  expect(await questEventCount(page)).toBe(0);

  await page.locator("#review-sign-proposal").click();
  await expect.poll(() => questEventCount(page)).toBe(1);
  expect(consoleErrors).toEqual([]);
});
