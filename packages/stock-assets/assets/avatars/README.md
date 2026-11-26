Images of the photorealistic stock avatars (`real_<slug>`). Synthetic people only, generated with
`services/avatar-engine` (never photos of real persons):

- `<slug>.jpg` — prepared portrait (square, upright, ≤ 768 px; JPEG ≤ 300 KB)
- `<slug>.mask.png` — alpha matte of the same size (white = person)
- `<slug>.thumb.webp` — 256-px thumbnail (cut-out over a neutral gradient)

Do not edit by hand: `services/avatar-engine/scripts/build_stock_avatars.py --publish …` writes
these files and the catalogue entries (`packages/stock-assets/src/photoreal-avatars.data.ts`) from
`services/avatar-engine/stock/avatars.json`. Catalogue API: `packages/stock-assets/src/photoreal-avatars.ts`.
