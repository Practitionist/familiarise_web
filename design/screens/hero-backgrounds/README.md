# Hero background options

Static previews of the four landing-page hero backgrounds compared on deploy previews in November 2026. Open any `.html` file in a browser; each is self-contained and uses the same values as its pull request.

| Option                              | File                   | Status                                       | Full TSX change                                                     |
| ----------------------------------- | ---------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| A. Dot grid with a top spotlight    | `a-dot-grid.html`      | Shipped in `components/home/HeroSection.tsx` | [#2980](https://github.com/Practitionist/familiarise_web/pull/2980) |
| B. Silver aurora glow               | `b-aurora.html`        | Kept as an alternative                       | [#2981](https://github.com/Practitionist/familiarise_web/pull/2981) |
| C. Outlined expert field names      | `c-field-names.html`   | Kept as an alternative                       | [#2982](https://github.com/Practitionist/familiarise_web/pull/2982) |
| D. Constellation of nodes and lines | `d-constellation.html` | Kept as an alternative                       | [#2983](https://github.com/Practitionist/familiarise_web/pull/2983) |

All four are static CSS or inline SVG with no images, scripts, blur or animation, so none affects load speed or layout shift. To switch options, replace the background layers at the top of the `<section>` in `HeroSection.tsx` with the block from that option's pull request. Option C reads its words from `EXPLORE_FIELDS` in `lib/navigation/public-nav.ts`.

A slow-motion variant and a bolder intensity are tracked in [#2979](https://github.com/Practitionist/familiarise_web/issues/2979).
