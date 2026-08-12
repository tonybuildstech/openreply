/**
 * Regenerates every app icon from the ONE brand source file.
 *
 * ── Why this script exists ───────────────────────────────────────────────────
 *
 * TikTok rejected the app in August 2026 with "Icon does not match brand — the
 * app icon submitted in the Basic Info does not match the icon displayed on the
 * website". The cause was drift: `public/openreply-logo.jpg` was uploaded to the
 * TikTok / Meta / Google dashboards by hand, while `app/favicon.ico` was still
 * the stock Next.js favicon that `create-next-app` ships. Nothing in the repo
 * tied the two together, so nobody noticed the browser tab was showing the
 * Next.js logo.
 *
 * Every icon below is therefore DERIVED from `SOURCE` rather than hand-made. If
 * the brand mark ever changes, replace that one file, run this script, and
 * re-upload the same file to the TikTok / Meta / Google dashboards. Do not
 * hand-edit the generated files — they will be overwritten.
 *
 *   npm run icons:generate
 *
 * ── Why the icons are a plain downscale ──────────────────────────────────────
 *
 * The mark is a 9-letter wordmark, so at 16-32px it renders as an illegible
 * smear no matter how it is cropped (a tighter crop was measured at ~20% bolder
 * and still unreadable). Cropping was rejected on purpose: the reviewer compares
 * the favicon against the square uploaded to TikTok, so framing them
 * identically matters more than small-size legibility. Keep this a pure
 * downscale of the full square.
 *
 * `sharp` is not a direct dependency — it arrives with Next.js (16.2.6), which
 * uses it for image optimisation. That is fine for a dev-only script, but it is
 * why the require is guarded.
 */

import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const require = createRequire(import.meta.url);

let sharp;
try {
  sharp = require("sharp");
} catch {
  console.error(
    "[icons] Could not load `sharp`. It normally comes with Next.js.\n" +
      "        Run `npm install` first, or `npm install --no-save sharp`."
  );
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The single source of truth. Also the file uploaded to TikTok / Meta / Google. */
const SOURCE = path.join(root, "public", "openreply-logo.jpg");

/**
 * Sizes baked into favicon.ico. 16/32 are the browser tab, 48 is the Windows
 * taskbar, 128/256 are pinned tiles and the "open in new tab" chrome. The whole
 * file still lands well under 20 kB because the mark is a near-flat dark square.
 */
const ICO_SIZES = [16, 32, 48, 128, 256];

/** Standalone PNGs Next.js picks up via the app/ metadata file conventions. */
const PNG_ICONS = [
  // app/icon.png  -> <link rel="icon" type="image/png" sizes="512x512">
  { file: path.join(root, "app", "icon.png"), size: 512 },
  // app/apple-icon.png -> <link rel="apple-touch-icon" sizes="180x180">
  // 180 is the size iOS asks for; it composites onto the home screen as-is.
  { file: path.join(root, "app", "apple-icon.png"), size: 180 },
];

/**
 * Square PNG of the source at `size`, as a raw buffer.
 *
 * `ensureAlpha` and `palette: false` are load-bearing, not cosmetic. The source
 * is a JPEG, so sharp would otherwise emit a 3-channel RGB PNG — and Turbopack
 * decodes app/favicon.ico with the Rust `image` crate, whose ICO reader accepts
 * PNG payloads ONLY in RGBA. An RGB payload fails the production build with
 * "Format error decoding Ico: The PNG is not in RGBA format!". Forcing a
 * 4-channel, non-palette PNG keeps the container decodable.
 */
async function renderSquare(size) {
  const data = await sharp(SOURCE)
    .resize(size, size, { fit: "cover" })
    .ensureAlpha()
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();

  // IHDR is the first chunk, so its colour-type byte sits at a fixed offset:
  // 8 signature + 4 length + 4 "IHDR" + 4 width + 4 height + 1 bit-depth = 25.
  // 6 == truecolour-with-alpha. Assert rather than trust, so a sharp upgrade
  // that changes the default cannot quietly break `next build` again.
  const colourType = data[25];
  if (colourType !== 6) {
    throw new Error(
      `${size}px PNG came out as colour type ${colourType}, expected 6 (RGBA). ` +
        "Turbopack's ICO decoder rejects anything else."
    );
  }
  return data;
}

/**
 * Packs PNG buffers into an .ico container.
 *
 * ICO is a 6-byte ICONDIR header, then one 16-byte ICONDIRENTRY per image, then
 * the image payloads. Each entry may hold either a headerless BMP or a complete
 * PNG; we use PNG, which every browser released in the last decade reads and
 * which keeps the file small. The width/height bytes are single bytes, so 256
 * is encoded as 0 — hence the `% 256`.
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved, always 0
  header.writeUInt16LE(1, 2); // 1 = icon (2 would be cursor)
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  // Payloads start after the header and the full directory.
  let offset = 6 + images.length * 16;

  images.forEach(({ size, data }, i) => {
    const entry = i * 16;
    directory.writeUInt8(size % 256, entry + 0); // width  (0 means 256)
    directory.writeUInt8(size % 256, entry + 1); // height (0 means 256)
    directory.writeUInt8(0, entry + 2); // palette size; 0 = truecolour
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.data)]);
}

async function main() {
  try {
    await fs.access(SOURCE);
  } catch {
    console.error(`[icons] Brand source missing: ${path.relative(root, SOURCE)}`);
    process.exit(1);
  }

  const { width, height } = await sharp(SOURCE).metadata();
  if (width !== height) {
    // A non-square source would be centre-cropped by `fit: "cover"`, silently
    // producing icons that no longer match what was uploaded to TikTok.
    console.error(
      `[icons] Brand source must be square; got ${width}x${height}. ` +
        "Square it up before regenerating, and upload the same square to TikTok."
    );
    process.exit(1);
  }

  const icoImages = await Promise.all(
    ICO_SIZES.map(async (size) => ({ size, data: await renderSquare(size) }))
  );
  const icoPath = path.join(root, "app", "favicon.ico");
  await fs.writeFile(icoPath, encodeIco(icoImages));
  console.log(
    `[icons] app/favicon.ico  (${ICO_SIZES.join(", ")}px)  ` +
      `${(await fs.stat(icoPath)).size} bytes`
  );

  for (const { file, size } of PNG_ICONS) {
    await fs.writeFile(file, await renderSquare(size));
    console.log(`[icons] ${path.relative(root, file).replace(/\\/g, "/")}  (${size}px)`);
  }

  console.log(
    "[icons] Done. These now match public/openreply-logo.jpg exactly — " +
      "upload that same file to TikTok / Meta / Google."
  );
}

await main();
