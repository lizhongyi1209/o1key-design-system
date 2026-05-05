# o1key Design System

> Punchy, anime-flavored techwear brand. Black + cream base, electric orange as the hero accent, teal as the rare gem.

## Brand Context

**o1key** is treated here as an anime/techwear-inspired digital brand for developer infrastructure (edge keys, auth, routing). The single source asset provided was `uploads/white.png` — an illustrated character (codename **JONY**) in profile: spiky blonde hair fading to dark roots, teal kite-shaped earring, black tactical jacket with orange "JONY" patch and orange X-strap accents.

> ⚠️ **Most of this system is inferred.** The user provided one illustration and let defaults apply for everything else. Treat color, type and tone choices as a strong opening proposal, not gospel. See *Caveats* at the end.

### Sources used
- `uploads/white.png` → copied to `assets/mascot-jony.png` (the only real input)
- No codebase, Figma, slide deck, logo, or fonts were provided.

### Products represented
- **Marketing website** — primary surface in `ui_kits/web/`

---

## Index

Root files:
- `README.md` — this file
- `SKILL.md` — agent skill manifest (drop-in for Claude Code)
- `colors_and_type.css` — all CSS vars + semantic type classes

Folders:
- `assets/` — `mascot-jony.png`, `logo-wordmark.svg`, `logo-glyph.svg`
- `fonts/` — webfonts (currently CDN-only; see Caveats)
- `preview/` — small HTML cards rendered in the Design System tab
- `ui_kits/web/` — marketing site UI kit
  - `index.html` — composed marketing page
  - `Nav.jsx`, `Hero.jsx`, `FeatureGrid.jsx`, `CodeBlock.jsx`, `Pricing.jsx`, `Footer.jsx`

---

## Content Fundamentals

**Voice:** punchy, technical, low-ego. Like a dev tool catalog meets a streetwear drop. Three-word headlines hit harder than one big sentence.

**Tone rules:**
- **You over we.** "Get a key." not "We provide keys."
- **Verb-first headlines.** "Drop in." "Run hot." "Punch through."
- **Short sentences.** Comma splices are fine when they keep momentum. Periods land hard.
- **Casing:** Sentence case for headings. `// MONO ALL CAPS` for eyebrows, serial numbers, status. Wordmark is always lowercase: `o1key`.
- **No emoji.** No exclamation marks. No "✨ magic ✨" copy.
- **Numbers carry weight.** `p95 · 12ms`, `14 regions`, `SOC 2 Type II`. Pair every claim with a number.
- **Serial numbers everywhere.** Decorative `SN · 0X1KEY-04A · 2026` strings give the techwear feel.
- **Mono comments inline.** `// SECTION HEADER` as eyebrows. Slashes signal a system, not a brand.

**Copy examples (good):**
- "One key. Every edge."
- "Six lines. That's the integration."
- "Pay for what you ship."
- "// 02 — WHAT'S INSIDE"

**Copy examples (avoid):**
- "Empower your team to unlock the future of authentication ✨"
- "We're so excited to announce..."
- "Revolutionary. Game-changing. Cutting-edge."

---

## Visual Foundations

**Colors.** Cream (`#FAF6EE`) page, ink (`#0A0908`) for type and structure. Orange `#FF5A1F` is the hero — used sparingly, never more than ~10% of a frame. Teal `#1FBFA8` is the rare-gem accent — 1–2 spots per page, like the earring on the mascot. No gradients. No pastels.

**Type.** Display: **Space Grotesk** 700 with -4% tracking — geometric, slightly off-kilter. Body: **Inter Tight** 400 — neutral, dense. Mono: **JetBrains Mono** 500 — used for eyebrows, serials, code, status. (All currently loaded via Google Fonts CDN.)

**Spacing.** 4px base scale (4, 8, 12, 16, 24, 32, 48, 64, 96). Sections breathe with 96px vertical padding. Cards use 24–28px internal padding.

**Backgrounds.** Flat cream or flat ink — no gradients, no textures, no full-bleed photography. Imagery is illustrated (the mascot) inside a framed window with mono labels, never full-bleed. A single black marquee strip with mono caps is the only "ornamental" pattern.

**Animation.** Minimal. Slow scrolling marquee for the techwear-tag strip. Hovers darken the orange (to `--orange-600`) or invert ink-on-cream cards. No bouncing, no spring physics, no parallax. Easing is `ease-out` 200ms when used.

**Hover states.** Buttons: shift the hard-offset shadow inward (or remove it) to simulate a press. Links: underline thickens or color shifts to orange. Cards: shadow color flips ink → orange.

**Press states.** Translate `+2px +2px` and zero the shadow — looks like the button "stamped" down.

**Borders.** Heavy and present. Default 1.5px ink, escalating to 2px for buttons/cards and 3px for emphasis frames. Borders are STRUCTURAL, not decorative — they outline every card, button, frame, divider.

**Shadows.** The signature is the **hard offset**: `3px 3px 0 0 #0A0908` (or `#FF5A1F` for emphasis). No bloom, no Gaussian softness. Soft shadows exist (`--shadow-soft`, `--shadow-lift`) but are reserved for floating menus, not surface elevation.

**Capsules vs gradients.** Always capsules / hard frames. Never use a gradient as a "protection" overlay on imagery — instead, frame the image in a 2px border with a mono ribbon header.

**Layout rules.** Generous whitespace, but with hard structural lines. Section dividers are 1.5px ink rules across the full width. Two-column hero (1.2fr / 1fr text-to-visual). Three-up grids for features and pricing.

**Transparency / blur.** Avoided. Backdrop-filter is not part of the system. If you need a stacking layer, use solid ink with a hard offset.

**Imagery vibe.** Anime/illustrated. Warm-toned. No photography of people. The mascot (JONY) is the brand's face.

**Corner radii.** Sharp by default (`radius-0`). `2px` and `4px` exist for inputs/code blocks. `8px` is the maximum normal radius. Pills (`999px`) are reserved for tags and status indicators only.

**Cards.** Cream or white surface, 2px ink border, `3px 3px 0 0` hard shadow. The "highlight" variant flips the shadow color to orange. No card uses both rounded corners AND a colored left-border — that combo is forbidden.

---

## Iconography

**System:** [Lucide Icons](https://lucide.dev) via CDN — outline style, 1.5–2px stroke, no fill. Size 16/20/24px depending on context. This is a **substitution** — no icon system was provided in the brand assets. *Flag this with the user when productionizing.*

**Mono glyphs as icons.** The brand makes heavy use of monospace characters as inline iconography:
- `→` `↗` `←` for navigation/links
- `×` for close/dismiss (often colored orange)
- `+` for crosshairs/markers
- `//` as a section/eyebrow prefix
- `[ ]` for code-block ornament
- `●` for status dots (paired with green/orange/red/grey)

**Logos:** `assets/logo-wordmark.svg` (full lockup) and `assets/logo-glyph.svg` (square 80×80 monogram). Both render the "1" in orange.

**Mascot:** `assets/mascot-jony.png`. Always presented inside a framed window with mono labels (`// JONY`, `0X1KEY-04A`) — never full-bleed, never naked on a page.

**No emoji.** Ever. Unicode block characters and arrows are fine.

---

## Caveats — please read

This system was built with **almost no input**: one mascot image and a brand name. Everything else — color, type, tone, layout, voice — is a **proposal**, not a derivation. Things to verify with the brand owner before any production use:

1. **Is JONY actually the mascot?** Or just a sample illustration? Big call to make.
2. **Color palette.** I anchored on the JONY orange (`#FF5A1F`) and earring teal (`#1FBFA8`). The cream page is a vibe choice, not a brand fact.
3. **Typography.** Space Grotesk / Inter Tight / JetBrains Mono are CDN substitutions for fonts that were never specified. Real font files are needed for production. The `fonts/` folder is empty for that reason.
4. **Voice & copy.** "One key. Every edge." is a placeholder tagline I wrote. The product positioning (developer auth/edge infra) is also a guess.
5. **Iconography.** Lucide is a substitute. If a real icon set exists, swap it in.
6. **No real codebase, Figma, or screenshots** were provided to verify pixel-fidelity against. The UI kit is a *proposal*, not a *recreation*.

**Big bold ask:** can you share a logo (SVG ideal), a real product description / tagline, font files, and any existing UI screenshots or a Figma link? With those, I can rebuild the foundations in 1–2 passes and the system becomes accurate instead of inferred.
