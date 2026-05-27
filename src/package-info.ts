import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MATEMATICA_PACKAGE_NAME = "@hasna/matematica";

type PackageMetadata = {
  root: string;
  version: string;
};

export function matematicaPackageVersion(cwd = process.cwd()): string {
  return findPackageMetadata(moduleDir())?.version ??
    findPackageMetadata(cwd)?.version ??
    "unknown";
}

export function matematicaPackageLockHash(cwd = process.cwd()): string | undefined {
  const roots = [
    findPackageMetadata(moduleDir())?.root,
    findPackageMetadata(cwd)?.root
  ].filter((root): root is string => typeof root === "string");

  for (const root of roots) {
    for (const filename of ["bun.lock", "bun.lockb"]) {
      const path = join(root, filename);
      if (existsSync(path)) {
        return createHash("sha256").update(readFileSync(path)).digest("hex");
      }
    }
  }
  return undefined;
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function findPackageMetadata(startDir: string): PackageMetadata | undefined {
  let current = startDir;
  while (true) {
    const packageJsonPath = join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === MATEMATICA_PACKAGE_NAME && typeof parsed.version === "string") {
        return { root: current, version: parsed.version };
      }
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
