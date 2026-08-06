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
- `partials/` contains isolated render partials.
- The shared layout links `/__uno.css` as a render-blocking head stylesheet.

Add, rename, or delete a Liquid page while the server runs and the route tree
updates automatically. Template errors use Vite's overlay and recover after the
file is fixed; newly rendered utility classes appear without a restart.

All styling uses Tailwind CSS utility syntax supported by UnoCSS Wind4.
