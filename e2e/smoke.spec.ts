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

  test("visit planner renders accessible, styled form controls", async ({ page }) => {
    await page.goto("/visit/")

    const name = page.getByRole("textbox", { name: "Your name" })
    const email = page.getByRole("textbox", { name: "Email address" })
    const day = page.getByRole("combobox", { name: "Best day to visit" })
    const note = page.getByRole("textbox", { name: "Anything we should know?" })
    const stepFree = page.getByRole("checkbox", {
      name: "Include step-free entrance directions in my plan",
    })
    const submit = page.getByRole("button", { name: "Build my visit plan" })

    await expect(name).toHaveAttribute("type", "text")
    await expect(name).toHaveAttribute("required", "")
    await expect(name).toHaveAttribute("aria-describedby", "visit-name-description")
    await expect(name).toHaveAccessibleDescription("Who should we expect at the bakery?")

    await expect(email).toHaveAttribute("type", "email")
    await expect(email).not.toHaveAttribute("required")
    await expect(email).toHaveAttribute("aria-describedby", "visit-email-description")
    await expect(email).toHaveAccessibleDescription(
      "Optional, in case you want a copy of your plan.",
    )

    await expect(day).toHaveAttribute("required", "")
    await expect(day).toHaveAttribute("aria-describedby", "visit-day-description")
    await expect(day).toHaveAccessibleDescription("We are open Tuesday through Sunday.")

    await expect(note).toHaveJSProperty("tagName", "TEXTAREA")
    await expect(note).not.toHaveAttribute("required")
    await expect(note).toHaveAttribute("aria-describedby", "visit-note-description")
    await expect(note).toHaveAccessibleDescription(
      "Optional. Add any detail that will help you plan the stop.",
    )

    await expect(stepFree).not.toBeChecked()
    await expect(stepFree).not.toHaveAttribute("required")
    await expect(submit).toHaveAttribute("type", "submit")
    await expect(name).toHaveCSS("border-radius", "16px")
    await expect(submit).toHaveCSS("background-color", /oklab/)
  })

  test("home link-buttons retain their route destinations", async ({ page }) => {
    await page.goto("/")

    await expect(page.getByRole("link", { name: "See today’s bake" })).toHaveAttribute(
      "href",
      "/menu/",
    )
    await expect(page.getByRole("link", { name: "Plan a visit" })).toHaveAttribute(
      "href",
      "/visit/",
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
