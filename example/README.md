# Example site

This directory is both a fixture for Splatpad's LiquidJS pipeline and a complete
fictional neighborhood bakery site. Run `splatpad serve example` for development
or `splatpad build example` for a production build. Liquid templates and site
JSON trigger a full reload.

- `pages/index.liquid` defines `/`; every other `pages/**/*.liquid` path becomes
  a nested route by convention. The journal demonstrates both
  `pages/journal/index.liquid` → `/journal/` and child pages such as
  `pages/journal/slow-mornings.html` → `/journal/slow-mornings/` and
  `pages/journal/seasonal-jam.liquid.html` → `/journal/seasonal-jam/`.
- `.liquid`, `.html`, and `.liquid.html` are LiquidJS template aliases; the
  longest matching suffix determines the route stem.
- `data/site.json` supplies global data and optional content keyed by canonical
  route. It does not declare routes.
- `layouts/` contains Liquid layouts.
- `components/` contains reusable Liquid components. `menu-card.liquid` shows
  explicit props, a default slot, a named slot, and nested component calls.
- `components/*.design.liquid` renders component variants in the design
  command's Components view. These files are previews, not site routes.
- The shared layout links `/__uno.css` as a render-blocking head stylesheet.

Component templates run in isolated scopes and receive only the props named in
their invocation, so required values must be passed explicitly. They render the
default slot with `{% yield %}` and named slots with `{% yield "name" %}`. Slot
bodies evaluate in the caller's scope, nested components are supported, and an
omitted named slot renders an empty string.

Every primitive in `components/` is used on a real example route:

- `button`, `link-button`, and `nav-link` cover form actions, linked actions,
  and current-route navigation. See the [home page](pages/index.liquid),
  [visit page](pages/visit.liquid), and [shared nav](layouts/base.liquid).
- `badge`, `card`, and `alert` cover labels, slotted content, and feedback. See
  the home page, [journal index](pages/journal/index.liquid), and
  [menu page](pages/menu.liquid).
- `field`, `input`, `textarea`, `select`, and `checkbox` compose the visit form.
- `menu-card` and `menu-mark` compose featured menu entries on the home page;
  `menu-card` also nests `card` and forwards caller-scoped slot content.

Add, rename, or delete a Liquid page while the server runs and the route tree
updates automatically. Template errors use Vite's overlay and recover after the
file is fixed; newly rendered utility classes appear without a restart.

All styling uses Tailwind CSS utility syntax supported by UnoCSS Wind4.
