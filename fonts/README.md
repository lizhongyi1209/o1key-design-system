# Fonts

This system loads its three families from Google Fonts via CDN (see the `@import` at the top of `../colors_and_type.css`):

- **Space Grotesk** — display
- **Inter Tight** — body
- **JetBrains Mono** — mono

No real font files were provided by the brand. When productionizing, drop self-hosted woff2 files into this folder and replace the `@import` in `colors_and_type.css` with local `@font-face` declarations.
