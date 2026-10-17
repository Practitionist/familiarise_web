# Familiarise brand assets

Original geometric `f` monogram and lowercase Sora wordmark, created for the landing-page refresh. The detached point is a subtle connection cue; the mark is deliberately monochrome and works without animation.

- `familiarise-wordmark-dark.svg`: dark ink on a transparent background.
- `familiarise-wordmark-light.svg`: white ink on a transparent background.
- `familiarise-symbol-dark.svg` / `familiarise-symbol-light.svg`: standalone marks.
- Matching wordmark PNGs: transparent, 3× resolution for raster-only tools.
- `familiarise-icon.svg` / `familiarise-favicon.ico`: high-contrast browser-tab icons. The ICO contains separate 16px, 32px and 48px frames and also refreshes Next's `app/favicon.ico`.
- `familiarise-apple-icon.png`: 180px home-screen icon.
- `landing-og.svg` / `landing-og.png`: 1200×630 social preview.
- `familiarise-brand-assets.zip`: the downloadable pack of the assets above and this usage guide. Repack it after regenerating exports.

The downloadable wordmarks contain outlined paths, not font-dependent SVG text. In the application, `FamiliariseLogo` uses the same geometry with the existing Sora font. Keep the wordmark lowercase, use the monochrome variant with sufficient background contrast, and allow at least half a mark's width around a standalone mark. Do not stretch the lockup or substitute the old ConsultX artwork.

The original shape is in `lib/brand.ts`. Regenerate mechanical exports with:

```sh
node scripts/brand/generate-landing-assets.cjs /absolute/path/to/Sora-variable.ttf
```

Use the [Sora variable TTF source](https://github.com/google/fonts/tree/main/ofl/sora), at weight 600 for the wordmark. Next's compressed WOFF2 subsets are deliberately rejected because the export tool cannot reliably interpolate their variation tables. The script needs the project's installed `tsx`, `fontkit`, and `sharp` tools, and does not fetch remote content. The font itself is not bundled in this asset pack.

This is original design work, not a trademark-availability assessment. Keep the previous artwork files intact for historical/reversible use; public navigation no longer uses them.
