# Example site

This directory is a fixture for developing Splatpad's LiquidJS pipeline. Run
`splatpad serve example` for development or `splatpad build example` for a
production build. Liquid templates and fixture JSON trigger a full reload.

- `pages/` contains entry templates.
- `layouts/` contains Liquid layouts.
- `partials/` contains isolated render partials.
- `data/site.json` contains the render context.
- `index.html` is Vite's entry; Splatpad replaces it with rendered Liquid.
- `src/main.ts` imports the generated UnoCSS stylesheet.

All styling uses Tailwind CSS utility syntax supported by UnoCSS Wind4.
