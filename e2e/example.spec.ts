import { expect, test } from "@playwright/test"

test.describe("example site", () => {
  test("renders the compiled product fixture", async ({ page }) => {
    await page.goto("/")

    await expect(page).toHaveTitle("Build small sites from clear inputs | Splatpad")
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Build small sites from clear inputs",
      }),
    ).toBeVisible()
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Templates",
      "Utilities",
      "Fixtures",
    ])
  })
})
