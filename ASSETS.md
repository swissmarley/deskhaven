# Assets and licenses

All art is original and generated at runtime or build time by code in this repository; no Habbo Hotel
assets, names, or logos are used.

| Asset | Source | License |
|---|---|---|
| Isometric tiles, furniture placeholders | drawn procedurally in `apps/web/src/game` | MIT (this repo) |
| Avatar sprite sheets | generated from palette/outfit parameters in `apps/web/src/game/sprites` | MIT (this repo) |
| Sounds | synthesised with WebAudio in `apps/web/src/game/sound.ts` | MIT (this repo) |

The asset manifest (`apps/web/src/game/assets/manifest.ts`) maps logical names to renderers so real
sprite sheets can replace the generated ones without code changes elsewhere.
