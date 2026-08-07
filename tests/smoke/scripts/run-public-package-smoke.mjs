/**
 * Public package-protocol smoke checks driven by the committed smoke contract.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SMOKE_ROOT = dirname(SCRIPT_DIR);
const REPO_ROOT = dirname(dirname(SMOKE_ROOT));
const CONTRACT_PATH = join(SMOKE_ROOT, "docs-contract/public-smoke-contract.json");
const SMOKE_ENV = {
  CORE_API_KEY: "public-smoke-core-key",
  DATABASE_URL: "postgres://atomicmemory:atomicmemory@127.0.0.1:5432/atomicmemory",
  EMBEDDING_DIMENSIONS: "1536",
  OPENAI_API_KEY: "public-smoke-openai-key",
  RAW_STORAGE_DEPLOYMENT_ENV: "local",
  STORAGE_KEY_HMAC_SECRET: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
};

function main() {
  const contract = readJson(CONTRACT_PATH);
  const rows = contract.rows.filter(isPackageProtocolRow);
  const failures = rows.flatMap(validateRow);

  if (failures.length > 0) {
    console.error("Public package smoke failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`PASS: public smoke validated ${rows.length} required release rows`);
}

function isPackageProtocolRow(row) {
  return row.required_for_public_release === true &&
    row.publish_status === "published" &&
    row.coverage_label === "package_protocol";
}

function validateRow(row) {
  // Not every required row is an npm package: the canonical `am` CLI is a
  // Rust binary distributed via GitHub Releases, so it has no package.json
  // and the npm pack / self-import checks below do not apply to it.
  if (row.kind === "binary") {
    return validateBinaryRow(row);
  }

  const packageDir = join(REPO_ROOT, row.monorepo_path);
  const manifestPath = join(packageDir, "package.json");
  const manifest = readJson(manifestPath);
  const buildFailure = buildPackage(row, manifest);
  if (buildFailure) {
    return [buildFailure];
  }

  return [
    ...validateManifest(row, manifest),
    ...validatePack(row, manifest, packageDir),
    ...validateRuntimeSurface(row, manifest, packageDir),
  ];
}

/**
 * Release-shape checks for a Rust binary row.
 *
 * Deliberately toolchain-free: the public smoke job installs Node and pnpm
 * only, so this asserts the declared release surface exists rather than
 * building the crate (the Rust build is covered by the fmt-clippy-test job).
 */
function validateBinaryRow(row) {
  const failures = [];
  const crateDir = join(REPO_ROOT, row.monorepo_path);
  const cargoPath = join(crateDir, "Cargo.toml");

  let cargo;
  try {
    cargo = readFileSync(cargoPath, "utf8");
  } catch {
    return [`${row.monorepo_path}: missing Cargo.toml for binary row ${row.name}`];
  }

  // The row name is the installed binary, which must be a real [[bin]] target.
  // Comments are stripped first: a commented-out `# [[bin]] / # name = "am"`
  // would otherwise satisfy the regex, so deleting the real declaration could
  // leave the release gate green.
  const binNames = [
    ...stripTomlComments(cargo).matchAll(/\[\[bin\]\][^[]*?name\s*=\s*"([^"]+)"/gs),
  ].map((match) => match[1]);
  if (!binNames.includes(row.name)) {
    failures.push(
      `${row.monorepo_path}: Cargo.toml declares no [[bin]] named "${row.name}" (found: ${
        binNames.join(", ") || "none"
      })`,
    );
  }

  if (!existsSync(join(crateDir, "README.md"))) {
    failures.push(`${row.monorepo_path}: README.md is required for a public row`);
  }

  // A published row must ship an install path that actually exists in-repo,
  // so the contract cannot advertise an installer that was renamed or removed.
  if (row.publish_status === "published" && !existsSync(join(REPO_ROOT, "scripts/install-cli.sh"))) {
    failures.push(
      `${row.monorepo_path}: scripts/install-cli.sh is missing but the row advertises an installer`,
    );
  }

  return failures;
}

/**
 * Remove TOML `#` comments, honoring quotes so a `#` inside a string value
 * (for example a URL fragment) is not treated as a comment start.
 */
function stripTomlComments(toml) {
  return toml
    .split("\n")
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === "#") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

function validateManifest(row, manifest) {
  const failures = [];
  if (manifest.name !== row.name) {
    failures.push(`${row.monorepo_path}: package name must be ${row.name}`);
  }
  if (manifest.private === true) {
    failures.push(`${row.monorepo_path}: required public row cannot be private`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    failures.push(`${row.monorepo_path}: package files array is required`);
  }
  return failures;
}

function buildPackage(row, manifest) {
  if (!manifest.scripts?.build) {
    return undefined;
  }

  const result = spawnSync("pnpm", ["--filter", manifest.name, "run", "build"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: smokeEnv(),
  });
  if (result.status === 0) {
    return undefined;
  }

  return [
    `${row.monorepo_path}: build failed before package smoke`,
    result.stdout.trim(),
    result.stderr.trim(),
  ].filter(Boolean).join("\n");
}

function validatePack(row, manifest, packageDir) {
  const output = npmPackDryRun(packageDir);
  if (output.failure) {
    return [`${row.monorepo_path}: ${output.failure}`];
  }

  const files = output.files;
  return [
    ...requiredPackedFiles(row, files, ["package.json", "README.md"]),
    ...requiredManifestFiles(row, manifest, files),
  ];
}

function npmPackDryRun(packageDir) {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return { failure: `npm pack --dry-run failed: ${result.stderr.trim()}` };
  }

  try {
    const pack = JSON.parse(extractJsonArray(result.stdout));
    return { files: new Set(pack[0].files.map((entry) => entry.path)) };
  } catch (error) {
    return { failure: `npm pack --dry-run emitted invalid JSON: ${error.message}` };
  }
}

function extractJsonArray(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("missing JSON array");
  }
  return output.slice(start, end + 1);
}

function requiredManifestFiles(row, manifest, files) {
  const required = [];
  if (manifest.exports?.["."]?.import) {
    required.push(stripDotSlash(manifest.exports["."].import));
  }
  if (manifest.main) {
    required.push(stripDotSlash(manifest.main));
  }
  for (const binPath of Object.values(manifest.bin ?? {})) {
    required.push(stripDotSlash(binPath));
  }
  return requiredPackedFiles(row, files, [...new Set(required)]);
}

function requiredPackedFiles(row, files, paths) {
  return paths.flatMap((path) => {
    return files.has(path) ? [] : [`${row.monorepo_path}: packed tarball missing ${path}`];
  });
}

function validateRuntimeSurface(row, manifest, packageDir) {
  if (!manifest.exports?.["."]?.import) {
    return [];
  }

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", "await import(process.argv[1]);", manifest.name],
    { cwd: packageDir, encoding: "utf8", env: smokeEnv() },
  );
  return result.status === 0 ? [] : [`${row.monorepo_path}: package self-import failed: ${result.stderr.trim()}`];
}

function smokeEnv() {
  return {
    ...process.env,
    ...SMOKE_ENV,
  };
}

function stripDotSlash(path) {
  return path.startsWith("./") ? path.slice(2) : path;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

main();
