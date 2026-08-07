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
    route: "/order/",
    title: "A cake worth gathering around | Crumb & Bloom",
    heading: "A cake worth gathering around",
    activeLink: "Order",
  },
  {
    route: "/order/cake/",
    title: "How many forks? | Crumb & Bloom",
    heading: "How many forks?",
    activeLink: "Order",
  },
  {
    route: "/order/cake/flavor/",
    title: "Choose your flavors | Crumb & Bloom",
    heading: "Choose your flavors",
    activeLink: "Order",
  },
  {
    route: "/order/cake/finish/",
    title: "Make it yours | Crumb & Bloom",
    heading: "Make it yours",
    activeLink: "Order",
  },
  {
    route: "/order/cake/pickup/",
    title: "When should it be ready? | Crumb & Bloom",
    heading: "When should it be ready?",
    activeLink: "Order",
  },
  {
    route: "/order/cake/review/",
    title: "Everything look delicious? | Crumb & Bloom",
    heading: "Everything look delicious?",
    activeLink: "Order",
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
      const primaryNavigation = page.getByRole("navigation", { name: "Primary navigation" })
      await expect(primaryNavigation.getByRole("link")).toHaveCount(6)
      await expect(
        primaryNavigation.getByRole("link", { name: pageDefinition.activeLink }),
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

  test("cake order moves through every wizard step", async ({ page }) => {
    await page.goto("/order/")
    await page.getByRole("link", { name: "Build your cake" }).click()
    await expect(page).toHaveURL(/\/order\/cake\/$/)

    await page.getByRole("link", { name: /Full table/ }).click()
    await page.getByRole("link", { name: /Vanilla & strawberry/ }).click()
    await page.getByRole("link", { name: /Garden flowers/ }).click()
    await page.getByRole("radio", { name: "Friday 19" }).check()
    await page.getByRole("radio", { name: "9:00–11:00" }).check()
    await expect(page.getByRole("radio", { name: "Friday 19" })).toBeChecked()
    await expect(page.getByRole("radio", { name: "9:00–11:00" })).toBeChecked()
    await page.getByRole("button", { name: "Review your order" }).click()

    await expect(page).toHaveURL(
      /\/order\/cake\/review\/\?pickup-date=19&pickup-window=9%3A00%E2%80%9311%3A00$/,
    )
    await expect(page.getByText("$72", { exact: true })).toBeVisible()
  })

  test("missing nested routes stay missing", async ({ request }) => {
    const response = await request.get("/journal/missing/")

    expect(response.status()).toBe(404)
  })
})
