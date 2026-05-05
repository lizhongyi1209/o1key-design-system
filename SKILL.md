---
name: o1key-design
description: Use this skill to generate well-branded interfaces and assets for o1key, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files (colors_and_type.css, assets/, ui_kits/web/, preview/).

Key points to internalize:
- **Vibe:** anime/techwear. Cream page, ink type, orange hero accent, rare teal gem.
- **Type:** Space Grotesk display, Inter Tight body, JetBrains Mono for eyebrows/serials/code.
- **Signature move:** hard-offset shadow (`3px 3px 0 0 #0A0908` or `#FF5A1F`), 2px ink borders, sharp corners.
- **Voice:** punchy, verb-first, technical. No emoji. Numbers carry every claim. `// MONO EYEBROWS` for section labels.
- **Mascot:** JONY (`assets/mascot-jony.png`) — frame in a 2px border with mono ribbon labels, never full-bleed.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out of this folder and create static HTML files for the user to view. Pull components from `ui_kits/web/` as reference; they're React/JSX with inline styles, easy to lift.

If working on production code, copy `colors_and_type.css` and the SVG logos. Real font files are NOT included — the system currently loads Google Fonts via CDN as a substitution; flag this and ask for real fonts before production.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.
