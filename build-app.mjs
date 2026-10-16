#!/usr/bin/env node
/* AniMehList: app build helper. Only .github/workflows/android.yml runs this; the website never does.
 *
 *   node build-app.mjs www       copy the website into www/ and swap every CDN link for a copy bundled inside the app
 *   node build-app.mjs icons     draw the app icon (every size Android wants) + the dark start-up screen from assets/logo.png,
 *                                straight into the generated Android project
 *   node build-app.mjs android   give the generated Android project its version number
 *
 * index.html itself is never changed: the website keeps loading its libraries from the CDNs, while the app gets its own
 * patched copy of the page that uses the bundled files. One index.html is both.
 * If you ever change a CDN link in index.html, this script notices (it stops with a message instead of guessing).
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "www");
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"; // so Google sends woff2 files

// ---------------------------------------------------------------------------------------------------- helpers
const note = (msg) => console.log(msg);
const warn = (msg) => console.log(`::warning::${msg}`);
function fail(msg) {
  console.log(`::error::${msg}`);
  process.exit(1);
}
const read = (p) => fs.readFileSync(p, "utf8");
function write(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}
const nm = (...p) => path.join(ROOT, "node_modules", ...p);
function need(p, what) {
  if (!fs.existsSync(p)) fail(`${what || path.relative(ROOT, p)} is missing. Did "npm install" finish without errors?`);
  return p;
}
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(need(from), to);
}
// Replace every match of `re`, and stop if the number of matches is not what we expect (the page changed under us).
function swap(html, re, to, label, expected = 1) {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const n = (html.match(new RegExp(re.source, flags)) || []).length;
  if (n !== expected) fail(`index.html has changed: found ${n} x "${label}" but expected ${expected}. build-app.mjs needs a matching update.`);
  return html.replace(new RegExp(re.source, flags), () => to);
}
function pageValue(html, re, label) {
  const m = html.match(re);
  if (!m) fail(`index.html has changed: could not find ${label}. build-app.mjs needs a matching update.`);
  return m[1];
}
function sameVersion(pkg, wanted) {
  const have = JSON.parse(read(need(nm(pkg, "package.json"), pkg))).version;
  if (have !== wanted) warn(`index.html loads ${pkg} ${wanted} from a CDN, but the app bundles ${have}. Make package.json say "${wanted}" so both match.`);
}
async function download(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= tries) fail(`Could not download ${url} (${e.message}). Press "Re-run jobs" to try again.`);
      await new Promise((res) => setTimeout(res, 1500 * i));
    }
  }
}

// ---------------------------------------------------------------------------------------------------- www
async function fonts(html) {
  // The page's own Google Fonts link is the single source of truth for which families and weights the app needs.
  const url = pageValue(html, /<link\s+href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)"\s+rel="stylesheet"\s*\/>/, "the Google Fonts <link>").replace(/&amp;/g, "&");
  const css = (await download(url)).toString("utf8");
  const dir = path.join(OUT, "vendor", "fonts");
  fs.mkdirSync(dir, { recursive: true });
  const names = new Map(); // remote url -> local file name
  let out = "";
  // Google marks every block with the alphabet it covers (/* latin */ ...). Latin + latin-ext cover all the app's own text;
  // anything else (Japanese titles ...) is drawn with the phone's own fonts, exactly as before.
  const re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[1] && !/^latin(-ext)?$/.test(m[1])) continue;
    const body = m[2].replace(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g, (_, u) => {
      if (!names.has(u)) names.set(u, `f${String(names.size + 1).padStart(2, "0")}-${path.basename(new URL(u).pathname)}`);
      return `url(${names.get(u)})`;
    });
    out += `/* ${m[1] || "font"} */\n@font-face {${body}}\n`;
  }
  if (!names.size) fail("Google Fonts sent no font files (the answer looked different than expected).");
  for (const [u, name] of names) fs.writeFileSync(path.join(dir, name), await download(u));
  write(path.join(dir, "fonts.css"), out);
  note(`fonts: ${names.size} files`);
}

async function www() {
  const esbuild = await import("esbuild");
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "vendor"), { recursive: true });

  // 1) the site itself
  let html = read(need(path.join(ROOT, "index.html"), "index.html"));
  copy(path.join(ROOT, "sw.js"), path.join(OUT, "sw.js"));
  if (fs.existsSync(path.join(ROOT, "manifest.webmanifest"))) copy(path.join(ROOT, "manifest.webmanifest"), path.join(OUT, "manifest.webmanifest"));
  if (fs.existsSync(path.join(ROOT, "assets"))) fs.cpSync(path.join(ROOT, "assets"), path.join(OUT, "assets"), { recursive: true });

  // 2) the libraries the page loads from CDNs -> files inside the app
  const animeV = pageValue(html, /animejs\/([\d.]+)\/anime\.min\.js/, "the anime.js <script>");
  const markedV = pageValue(html, /marked@([\d.]+)\/lib\/marked\.umd\.js/, "the marked <script>");
  const faV = pageValue(html, /font-awesome\/([\d.]+)\/css\/all\.min\.css/, "the Font Awesome <link>");
  sameVersion("animejs", animeV);
  sameVersion("marked", markedV);
  sameVersion("@fortawesome/fontawesome-free", faV);

  copy(nm("animejs", "lib", "anime.min.js"), path.join(OUT, "vendor", "anime.min.js"));
  copy(nm("marked", "lib", "marked.umd.js"), path.join(OUT, "vendor", "marked.umd.js"));
  copy(nm("@fortawesome", "fontawesome-free", "css", "all.min.css"), path.join(OUT, "vendor", "fa", "css", "all.min.css"));
  need(nm("@fortawesome", "fontawesome-free", "webfonts"), "the Font Awesome icon fonts");
  fs.cpSync(nm("@fortawesome", "fontawesome-free", "webfonts"), path.join(OUT, "vendor", "fa", "webfonts"), { recursive: true });
  await fonts(html);

  // the backend library (supabase-js): one self-contained file instead of esm.sh
  await esbuild.build({
    stdin: { contents: 'export * from "@supabase/supabase-js";', resolveDir: ROOT, loader: "js" },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome90"],
    minify: true,
    legalComments: "none",
    outfile: path.join(OUT, "vendor", "supabase.js"),
    logLevel: "warning",
  });

  // the Capacitor plugins (back button, share sheet, files, system bars) -> window.AmlNative, which the page looks for
  await esbuild.build({
    stdin: {
      contents: [
        'import * as Core from "@capacitor/core";',
        'import { App } from "@capacitor/app";',
        'import { Share } from "@capacitor/share";',
        'import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";',
        "window.AmlNative = { Capacitor: Core.Capacitor, SystemBars: Core.SystemBars, App, Share, Filesystem, Directory, Encoding };",
      ].join("\n"),
      resolveDir: ROOT,
      loader: "js",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome90"],
    minify: true,
    legalComments: "none",
    outfile: path.join(OUT, "vendor", "native.js"),
    logLevel: "warning",
  });

  // 3) point the app's copy of the page at those files
  html = swap(html, /<link\s+rel="preconnect"\s+href="https:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com|esm\.sh)"[^>]*\/>\s*/, "", "preconnect to font / library hosts", 3);
  html = swap(html, /<link\s+rel="modulepreload"\s+href="https:\/\/esm\.sh\/@supabase\/supabase-js@2"\s*\/>/, '<link rel="modulepreload" href="vendor/supabase.js" />', "modulepreload of supabase-js");
  html = swap(html, /<link\s+href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+"\s+rel="stylesheet"\s*\/>/, '<link href="vendor/fonts/fonts.css" rel="stylesheet" />', "Google Fonts <link>");
  html = swap(html, /<link\s+href="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome\/[\d.]+\/css\/all\.min\.css"\s+rel="stylesheet"\s*\/>/, '<link href="vendor/fa/css/all.min.css" rel="stylesheet" />', "Font Awesome <link>");
  html = swap(
    html,
    /<script defer src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/animejs\/[\d.]+\/anime\.min\.js"><\/script>/,
    '<script src="vendor/native.js"></script>\n    <script defer src="vendor/anime.min.js"></script>',
    "anime.js <script>"
  );
  html = swap(html, /<script defer src="https:\/\/cdn\.jsdelivr\.net\/npm\/marked@[\d.]+\/lib\/marked\.umd\.js"><\/script>/, '<script defer src="vendor/marked.umd.js"></script>', "marked <script>");
  html = swap(html, /const SUPABASE_LIB_URLS = \[[\s\S]*?\];/, 'const SUPABASE_LIB_URLS = ["./vendor/supabase.js"];', "SUPABASE_LIB_URLS list");

  // nothing may still point at a CDN: the app has to start with no connection at all
  const left = html.match(/https:\/\/(?:esm\.sh|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|unpkg\.com)[^"'\s)<]*/g);
  if (left) fail(`The app copy of the page still loads from a CDN: ${[...new Set(left)].join(", ")}. build-app.mjs needs a matching update.`);

  write(path.join(OUT, "index.html"), html);
  note(`www ready: ${fs.readdirSync(OUT).join(", ")}`);
}

// ---------------------------------------------------------------------------------------------------- icons
// One logo file (assets/logo.png) becomes: the launcher icon in every size, the round icon, the adaptive icon layers, the
// colour behind the adaptive icon and a plain dark start-up screen. They are written over the default Capacitor ones inside
// android/app/src/main/res. (A small drawer of our own instead of one more third-party tool: fewer moving parts.)
const BG = "#0b0c10"; // the app's default (dark) background: what the phone shows while the app is starting
const ALPHA_MIN = 24; // pixels fainter than this (of 255) do not count as "drawn"
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }; // 48 px icon / 108 px adaptive layer, times this
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Finds what is really drawn in the logo (its bounding box, and how far from the middle it reaches), so a logo with
// lots of empty margin, or a wide one, is sized by what you can see and not by the size of its file.
function measureLogo(data, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < ALPHA_MIN) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  let reach = 0; // distance from the middle of the box to the farthest drawn pixel corner
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (data[(y * width + x) * 4 + 3] < ALPHA_MIN) continue;
      const dx = Math.max(Math.abs(x - x0 - w / 2), Math.abs(x + 1 - x0 - w / 2));
      const dy = Math.max(Math.abs(y - y0 - h / 2), Math.abs(y + 1 - y0 - h / 2));
      const d = Math.hypot(dx, dy);
      if (d > reach) reach = d;
    }
  }
  return { x0, y0, w, h, reach };
}

// An antialiased solid shape in the background colour: "circle" or a rounded square.
function shapePixels(size, kind) {
  const [r, g, b] = hexRgb(BG);
  const buf = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const corner = kind === "circle" ? half : size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const qx = Math.abs(x + 0.5 - half) - (half - corner);
      const qy = Math.abs(y + 0.5 - half) - (half - corner);
      const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner; // < 0 inside
      const o = (y * size + x) * 4;
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
      buf[o + 3] = Math.round(255 * Math.max(0, Math.min(1, 0.5 - dist)));
    }
  }
  return buf;
}

async function icons() {
  const sharp = (await import("sharp")).default;
  const src = path.join(ROOT, "assets", "logo.png");
  if (!fs.existsSync(src)) fail("assets/logo.png not found (the app icon is made from it).");
  const res = path.join(ROOT, "android", "app", "src", "main", "res");
  if (!fs.existsSync(res)) fail("The Android project (android/app/src/main/res) was not found. The step that creates it has to run before this one.");

  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4 || data.length !== info.width * info.height * 4) fail("assets/logo.png has a PNG format I cannot read. Save it again as a normal 8-bit PNG.");
  const box = measureLogo(data, info.width, info.height);
  if (!box) fail("assets/logo.png is empty (completely see-through).");
  if (Math.max(box.w, box.h) < 400) warn(`assets/logo.png is small (the picture itself is ${box.w}x${box.h} px). The icon will look soft; 512x512 or bigger is best.`);
  const logo = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract({ left: box.x0, top: box.y0, width: box.w, height: box.h })
    .png()
    .toBuffer();

  // A transparent square of `size` with the logo in the middle, as large as possible while every visible part stays inside a
  // circle of `safe` x size radius (a launcher may cut the icon into a circle, so nothing important may stick out).
  async function layer(size, safe) {
    const k = Math.min((safe * size) / box.reach, size / Math.max(box.w, box.h));
    const w = Math.max(1, Math.round(box.w * k)), h = Math.max(1, Math.round(box.h * k));
    const fitted = await sharp(logo).resize(w, h, { fit: "fill" }).png().toBuffer();
    return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: fitted, left: Math.round((size - w) / 2), top: Math.round((size - h) / 2) }])
      .png()
      .toBuffer();
  }
  const save = (pngBuffer, file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return sharp(pngBuffer).png({ compressionLevel: 9 }).toFile(file);
  };
  async function onShape(size, kind, safe) {
    const base = sharp(shapePixels(size, kind), { raw: { width: size, height: size, channels: 4 } });
    return base.composite([{ input: await layer(size, safe) }]).png().toBuffer();
  }

  let files = 0;
  for (const [density, factor] of Object.entries(DENSITIES)) {
    const dir = path.join(res, `mipmap-${density}`);
    const small = Math.round(48 * factor), big = Math.round(108 * factor);
    await save(await onShape(small, "square", 0.4), path.join(dir, "ic_launcher.png")); // Android 7 and old launchers
    await save(await onShape(small, "circle", 0.36), path.join(dir, "ic_launcher_round.png"));
    await save(await layer(big, 0.3), path.join(dir, "ic_launcher_foreground.png")); // Android 8+: the logo layer; the launcher shapes it
    files += 3;
  }
  // Android 8+ builds the icon from two layers: this colour behind, the logo in front. These two small files tie them together.
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n`;
  write(path.join(res, "mipmap-anydpi-v26", "ic_launcher.xml"), adaptive);
  write(path.join(res, "mipmap-anydpi-v26", "ic_launcher_round.xml"), adaptive);
  write(path.join(res, "values", "ic_launcher_background.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG}</color>\n</resources>\n`);

  // The start-up picture: Capacitor ships a white one, which flashes before the dark app appears. Same sizes, plain dark.
  let splashes = 0;
  for (const dir of fs.readdirSync(res).filter((d) => /^drawable/.test(d))) {
    const file = path.join(res, dir, "splash.png");
    if (!fs.existsSync(file)) continue;
    const { width, height } = await sharp(file).metadata();
    const dark = await sharp({ create: { width, height, channels: 3, background: BG } }).png({ compressionLevel: 9 }).toBuffer();
    fs.writeFileSync(file, dark);
    splashes++;
  }
  // Android 12+ draws its own start-up screen (the icon on a colour) before the app can show anything: give it the dark colour too.
  const styles = path.join(res, "values", "styles.xml");
  const block = fs.existsSync(styles) ? read(styles).match(/<style\s+name="AppTheme\.NoActionBarLaunch"\s+parent="([^"]+)"\s*>([\s\S]*?)<\/style>/) : null;
  if (block) {
    const items = block[2].replace(/^[ \t]*<item\s+name="android:windowSplashScreenBackground">[^<]*<\/item>[ \t]*\r?\n?/gm, "").replace(/\s+$/, "");
    write(
      path.join(res, "values-v31", "aml_launch_theme.xml"),
      `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <style name="AppTheme.NoActionBarLaunch" parent="${block[1]}">${items}\n        <item name="android:windowSplashScreenBackground">${BG}</item>\n    </style>\n</resources>\n`
    );
  } else {
    warn("Could not find AppTheme.NoActionBarLaunch in styles.xml, so the Android 12+ start-up screen keeps its default colour (the app and the icon are fine).");
  }
  note(`icons: ${files} icon files, ${splashes} start-up pictures${block ? ", Android 12+ start-up colour" : ""}`);
}

// ---------------------------------------------------------------------------------------------------- android
function android() {
  const name = process.env.AML_VERSION_NAME;
  const code = process.env.AML_VERSION_CODE;
  if (!name || !/^\d+$/.test(code || "")) fail("AML_VERSION_NAME / AML_VERSION_CODE are not set.");
  const file = path.join(ROOT, "android", "app", "build.gradle");
  let g = read(need(file, "android/app/build.gradle"));
  const once = (re, to, label) => {
    const n = (g.match(new RegExp(re.source, "g")) || []).length;
    if (n !== 1) {
      console.log(g.split("\n").slice(0, 60).join("\n"));
      fail(`android/app/build.gradle looks different than expected (found ${n} x ${label}). build-app.mjs needs a matching update.`);
    }
    g = g.replace(re, to);
  };
  once(/(versionCode\s*=?\s*)\d+/, (_, a) => `${a}${code}`, "versionCode");
  once(/(versionName\s*=?\s*)"[^"]*"/, (_, a) => `${a}"${name}"`, "versionName");
  write(file, g);
  note(`android version: ${name} (code ${code})`);
}

// ---------------------------------------------------------------------------------------------------- go
const modes = { www, icons, android };
if (!modes[process.argv[2]]) fail("usage: node build-app.mjs www | icons | android");
Promise.resolve()
  .then(() => modes[process.argv[2]]())
  .catch((e) => fail(e && e.stack ? e.stack : String(e)));
