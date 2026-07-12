import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const packages = Object.entries(lock.packages)
  .filter(([path, metadata]) => path.startsWith("node_modules/") && !metadata.dev)
  .map(([path]) => {
    const directory = join(root, path);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const noticeFiles = readdirSync(directory)
      .filter((name) => /^(?:licen[cs]e|copying|notice)/iu.test(name))
      .sort();
    if (noticeFiles.length === 0) throw new Error(`No license file found for ${manifest.name}`);
    return {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? "See included license text",
      notices: noticeFiles.map((name) => ({
        name,
        text: readFileSync(join(directory, name), "utf8")
          .replace(/\r\n?/gu, "\n")
          .split("\n")
          .map((line) => line.replace(/[ \t]+$/gu, ""))
          .join("\n")
          .trim(),
      })),
    };
  })
  .sort((left, right) => left.name.localeCompare(right.name));

const divider = "=".repeat(78);
const output = [
  "RAPP HEIR — THIRD-PARTY PRODUCTION DEPENDENCY LICENSES",
  "",
  "Generated from package-lock.json by scripts/generate-third-party-licenses.mjs.",
  "Development-only dependencies are not included in this distribution notice.",
  "",
  `Production packages covered: ${packages.length}`,
  "",
  "INVENTORY",
  ...packages.map(({ name, version, license }) => `${name}@${version} — ${license}`),
  "",
  ...packages.flatMap(({ name, version, license, notices }) => [
    divider,
    `${name}@${version}`,
    `Declared license: ${license}`,
    divider,
    ...notices.flatMap(({ name: fileName, text }) => ["", `--- ${fileName} ---`, "", text, ""]),
  ]),
].join("\n");

writeFileSync(join(root, "public", "THIRD_PARTY_LICENSES.txt"), `${output.trim()}\n`);
