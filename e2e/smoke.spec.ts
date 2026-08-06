import { expect, test } from "@playwright/test"

const pages = [
  {
    route: "/",
    title: "A little joy, baked daily | Crumb & Bloom",
    heading: "A little joy, baked daily",
    activeLink: "Home",
  },
  {
    route: "/menu/",
    title: "Today’s bake | Crumb & Bloom",
    heading: "Today’s bake",
    activeLink: "Menu",
  },
  {
    route: "/story/",
    title: "Rooted in the neighborhood | Crumb & Bloom",
    heading: "Rooted in the neighborhood",
    activeLink: "Story",
  },
  {
    route: "/journal/",
    title: "Notes from the bakehouse | Crumb & Bloom",
    heading: "Notes from the bakehouse",
    activeLink: "Journal",
  },
  {
    route: "/journal/slow-mornings/",
    title: "Why good bread takes the long way | Crumb & Bloom",
    heading: "Why good bread takes the long way",
    activeLink: "Journal",
  },
  {
    route: "/journal/seasonal-jam/",
    title: "The jam jar follows the weather | Crumb & Bloom",
    heading: "The jam jar follows the weather",
    activeLink: "Journal",
  },
  {
    route: "/visit/",
    title: "Come by for something warm | Crumb & Bloom",
    heading: "Come by for something warm",
    activeLink: "Visit",
  },
]

test.describe("Crumb & Bloom", () => {
  for (const pageDefinition of pages) {
    test(`${pageDefinition.route} is a distinct, navigable built page`, async ({ page }) => {
      const response = await page.goto(pageDefinition.route)

      expect(response?.status()).toBe(200)
      await expect(page).toHaveTitle(pageDefinition.title)
      await expect(
        page.getByRole("heading", { level: 1, name: pageDefinition.heading }),
      ).toBeVisible()
      await expect(page.getByRole("navigation").getByRole("link")).toHaveCount(5)
      await expect(
        page.getByRole("navigation").getByRole("link", { name: pageDefinition.activeLink }),
      ).toHaveAttribute("aria-current", "page")
      await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute(
        "href",
        /\/assets\/__uno-.*\.css/,
      )
      await expect(page.locator("body")).toHaveCSS("background-color", /oklab/)
    })
  }

  test("page-specific content receives generated utility styling", async ({ page }) => {
    await page.goto("/menu/")
    await expect(page.getByText("Our case changes with the season.")).toHaveCSS(
      "background-color",
      /oklab/,
    )

    await page.goto("/story/")
    await expect(page.getByRole("heading", { level: 2, name: "Made for today" })).toHaveCSS(
      "color",
      /oklab/,
    )

    await page.goto("/visit/")
    await expect(page.getByRole("region", { name: "Map to the bakery" })).toHaveCSS(
      "background-color",
      /oklab/,
    )
  })

  test("journal cards navigate into nested child routes", async ({ page }) => {
    await page.goto("/journal/")
    await page.getByRole("link", { name: "Read the note" }).first().click()

    await expect(page).toHaveURL(/\/journal\/slow-mornings\/$/)
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Why good bread takes the long way",
    )
  })

  test("missing nested routes stay missing", async ({ request }) => {
    const response = await request.get("/journal/missing/")

    expect(response.status()).toBe(404)
  })
})
