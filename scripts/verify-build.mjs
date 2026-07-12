import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = readFileSync(join(root, "public", "THIRD_PARTY_LICENSES.txt"));
const built = readFileSync(join(root, "dist", "THIRD_PARTY_LICENSES.txt"));

if (!source.equals(built)) {
  throw new Error("Production build is missing the exact generated third-party license bundle");
}

console.log("Verified dist/THIRD_PARTY_LICENSES.txt");
