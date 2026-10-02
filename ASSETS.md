# Assets and licenses

All art is original and generated at runtime or build time by code in this repository; no Habbo Hotel
assets, names, or logos are used.

| Asset | Source | License |
|---|---|---|
| Isometric tiles, furniture placeholders | drawn procedurally in `apps/web/src/game` | MIT (this repo) |
| Avatar sprite sheets | generated at runtime by `apps/web/src/game/sprites.ts` from the `Avatar` DTO: 16×28 logical pixels, scale 2, 11 pose columns (idle, walk×4, sit, type×2, read, raise, nap) × 4 facing rows, frame key `${pose}_${facing}_${index}`, cached per avatar in `assets/generated.ts` | MIT (this repo) |
| Sounds | synthesised with WebAudio in `apps/web/src/game/sound.ts` | MIT (this repo) |

The asset manifest (`apps/web/src/game/assets/manifest.ts`) maps logical names to renderer kinds: `placeholder` (iso boxes), `generated` (runtime pixel art, the default for avatars) and `sheet` (file-backed sprite sheets, reserved: `loadPainters` fails loudly until a sheet painter exists). Swapping art means changing the manifest entry, not the world code.
