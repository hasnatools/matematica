import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type AppPaths = {
  root: string;
  dbPath: string;
  artifactsDir: string;
};

export function getAppPaths(cwd = process.cwd()): AppPaths {
  const root = resolve(process.env.MATEMATICA_HOME ?? join(cwd, ".matematica"));
  const artifactsDir = join(root, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  return {
    root,
    dbPath: join(root, "matematica.sqlite"),
    artifactsDir
  };
}
