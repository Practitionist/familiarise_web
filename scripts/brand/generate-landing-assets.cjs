/* Original vector geometry + outlined Sora lettering; no network or runtime dependency. */
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS asset generator. */
require("tsx/cjs");
const fs = require("node:fs");
const path = require("node:path");
const fontkit = require("fontkit");
const sharp = require("sharp");
const { FAMILIARISE_MARK_PATHS } = require("../../lib/brand.ts");

const root = path.resolve(__dirname, "../..");
const output = path.join(root, "public/brand");
const suppliedFont = process.argv[2];
if (!suppliedFont)
  throw new Error(
    "Supply the Sora variable TTF source path. See public/brand/README.md.",
  );
const baseFont = fontkit.openSync(path.resolve(suppliedFont));
if (
  baseFont.familyName !== "Sora" ||
  !baseFont.hasGlyphForCodePoint(102) ||
  baseFont.type === "WOFF2"
) {
  throw new Error(
    "Use the Sora variable TTF source, not a compressed Next font subset.",
  );
}
const atWeight = (weight) => baseFont.getVariation({ wght: weight });

function lettering(
  text,
  {
    x = 0,
    y = 0,
    size = 40,
    color = "#18181b",
    weight = 600,
    tracking = 0,
  } = {},
) {
  const font = atWeight(weight);
  const run = font.layout(text);
  const scale = size / font.unitsPerEm;
  let cursor = x;
  return run.glyphs
    .map((glyph, index) => {
      const position = run.positions[index];
      const svg = `<path d="${glyph.path.toSVG()}" transform="translate(${cursor + position.xOffset * scale} ${y - position.yOffset * scale}) scale(${scale} ${-scale})" fill="${color}"/>`;
      cursor += position.xAdvance * scale + size * tracking;
      return svg;
    })
    .join("");
}

const mark = (color) =>
  `<g fill="${color}">${FAMILIARISE_MARK_PATHS.map((d) => `<path d="${d}"/>`).join("")}</g>`;
const svg = (width, height, content, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title"><title id="title">${title}</title>${content}</svg>\n`;

async function generate() {
  fs.mkdirSync(output, { recursive: true });
  for (const [theme, color] of [
    ["dark", "#18181b"],
    ["light", "#ffffff"],
  ]) {
    const font = atWeight(600);
    const width = Math.ceil(
      (font
        .layout("familiarise")
        .positions.reduce((sum, position) => sum + position.xAdvance, 0) *
        40) /
        font.unitsPerEm -
        40 * 0.055 * 9 +
        72,
    );
    const lockup = svg(
      width,
      64,
      `<g transform="translate(3 8)">${mark(color)}</g>${lettering("familiarise", { x: 63, y: 47, size: 40, color, tracking: -0.055 })}`,
      "Familiarise",
    );
    fs.writeFileSync(
      path.join(output, `familiarise-wordmark-${theme}.svg`),
      lockup,
    );
    fs.writeFileSync(
      path.join(output, `familiarise-symbol-${theme}.svg`),
      svg(48, 48, mark(color), "Familiarise symbol"),
    );
    await sharp(Buffer.from(lockup))
      .resize({ width: width * 3 })
      .png()
      .toFile(path.join(output, `familiarise-wordmark-${theme}.png`));
  }
  const icon = svg(
    64,
    64,
    `<rect width="64" height="64" rx="16" fill="#18181b"/><g transform="translate(8 8)">${mark("#ffffff")}</g>`,
    "Familiarise",
  );
  fs.writeFileSync(path.join(output, "familiarise-icon.svg"), icon);
  await sharp(Buffer.from(icon))
    .resize(180, 180)
    .png()
    .toFile(path.join(output, "familiarise-apple-icon.png"));
  // ICO directories wrap PNG frames, preserving sharp edges at each tab size.
  // Refresh Next's automatic file icon too; metadata alone leaves it in place.
  const iconSizes = [16, 32, 48];
  const frames = await Promise.all(
    iconSizes.map((size) =>
      sharp(Buffer.from(icon)).resize(size, size).png().toBuffer(),
    ),
  );
  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    directory[entry] = iconSizes[index];
    directory[entry + 1] = iconSizes[index];
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(frame.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  const ico = Buffer.concat([directory, ...frames]);
  fs.writeFileSync(path.join(output, "familiarise-favicon.ico"), ico);
  fs.writeFileSync(path.join(root, "app/favicon.ico"), ico);
  const social = svg(
    1200,
    630,
    `
    <defs><radialGradient id="glow"><stop stop-color="#303030"/><stop offset="1" stop-color="#090909"/></radialGradient></defs>
    <rect width="1200" height="630" fill="#090909"/>
    <ellipse cx="1100" cy="520" rx="600" ry="450" fill="url(#glow)"/>
    <g transform="translate(64 56)">${mark("#ffffff")}</g>
    ${lettering("familiarise", { x: 124, y: 94, size: 34, color: "#ffffff", tracking: -0.055 })}
    ${lettering("The right expert.", { x: 72, y: 270, size: 70, color: "#ffffff" })}
    ${lettering("A clearer way forward.", { x: 72, y: 366, size: 70, color: "#a1a1aa" })}
    <path d="M72 426H1128" stroke="#333333"/>
    ${lettering("One-to-one advice. Ongoing mentorship. Live learning.", { x: 72, y: 488, size: 24, color: "#d4d4d8", weight: 400 })}
    ${lettering("Start with your next step.", { x: 72, y: 551, size: 24, color: "#ffffff", weight: 400 })}
  `,
    "Familiarise — the right expert, a clearer way forward",
  );
  fs.writeFileSync(path.join(output, "landing-og.svg"), social);
  await sharp(Buffer.from(social))
    .png()
    .toFile(path.join(output, "landing-og.png"));
  console.log(
    "Generated outlined SVG wordmarks, symbols, PNGs, tab/home-screen icons, and social artwork in public/brand; refreshed app/favicon.ico.",
  );
}

generate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
