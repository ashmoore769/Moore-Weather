"use strict";

// Offline validation: this does not start the server or contact the station.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function checkAsset(url, source) {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(url)) return;
  const pathname = decodeURIComponent(url.split(/[?#]/, 1)[0]);
  if (pathname === "/skycam/latest.jpg") return; // Dynamic server route.
  if (!/\.(?:png|jpg|jpeg|ico|html|css|js|webmanifest)$/i.test(pathname)) return;
  // server.js intentionally serves this alias from favicon.png.
  const asset = pathname === "/favicon.ico" ? "favicon.png" : pathname.replace(/^\//, "");
  const resolved = path.resolve(publicDir, asset);
  if (!resolved.startsWith(publicDir + path.sep) || !fs.existsSync(resolved)) {
    throw new Error(`${source}: missing local asset ${url}`);
  }
}

let scripts = 0;
const javascriptFiles = ['server.js', ...['tools', 'lib', 'test', 'public'].flatMap(dir =>
  fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir))
    .filter(name => name.endsWith('.js')).map(name => `${dir}/${name}`) : [])];
for (const file of javascriptFiles) {
  new vm.Script(read(file), { filename: file });
  scripts++;
}
for (const name of fs.readdirSync(publicDir).filter((name) => name.endsWith(".html"))) {
  const file = `public/${name}`;
  const html = read(file);
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!match[1].trim()) continue;
    new vm.Script(match[1], { filename: file });
    scripts++;
  }
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    checkAsset(match[1], file);
  }
  for (const match of html.matchAll(/url\(\s*["']?([^\s)"']+)/gi)) {
    checkAsset(match[1], file);
  }
}
const manifest = JSON.parse(read("public/site.webmanifest"));
for (const icon of manifest.icons) checkAsset(icon.src, "public/site.webmanifest");
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
if (JSON.stringify(pkg.dependencies) !== JSON.stringify(lock.packages[""].dependencies)) {
  throw new Error("package.json dependencies and package-lock.json disagree.");
}
console.log(`Passed: ${scripts} JavaScript syntax checks, local page assets, app manifest and dependency declarations.`);
console.log("This is an offline check; live station, login and SkyCam behaviour require a separate smoke test.");
