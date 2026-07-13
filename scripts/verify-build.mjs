import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = readFileSync(join(root, "public", "THIRD_PARTY_LICENSES.txt"));
const built = readFileSync(join(root, "dist", "THIRD_PARTY_LICENSES.txt"));

if (!source.equals(built)) {
  throw new Error("Production build is missing the exact generated third-party license bundle");
}

const manifest = JSON.parse(readFileSync(join(root, "dist", "asset-manifest.json"), "utf8"));
const builtAssets = readdirSync(join(root, "dist", "assets"))
  .filter((name) => /\.(?:css|js)$/u.test(name))
  .map((name) => `/rapp-heir/assets/${name}`)
  .sort();
if (
  manifest.version !== 1 ||
  JSON.stringify(manifest.assets) !== JSON.stringify(builtAssets)
) {
  throw new Error("Production asset manifest does not list every built JS/CSS chunk");
}

for (const fileName of [
  "NOTICE.md",
  "LICENSE",
  "ROADMAP.md",
  "SECURITY.md",
  "PRIVACY.md",
  "PROTOCOL.md",
]) {
  if (
    !readFileSync(join(root, fileName)).equals(
      readFileSync(join(root, "dist", fileName)),
    )
  ) {
    throw new Error(`Production build is missing exact ${fileName}`);
  }
}

console.log("Verified licenses, public documents, and complete built asset manifest");
