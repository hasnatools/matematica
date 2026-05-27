import { expect, test } from "bun:test";
import { runCli } from "../src/cli";
import {
  EXECUTION_CONTRACT,
  formatExecutionContract,
  validateExecutionContract
} from "../src/execution-contract";

test("execution contract separates free local OSS from paid BYOK remote mode", () => {
  expect(validateExecutionContract()).toEqual({ ok: true, issues: [] });
  expect(EXECUTION_CONTRACT.modes.map((mode) => mode.id)).toEqual([
    "free-local-oss",
    "paid-byok-remote"
  ]);

  const free = EXECUTION_CONTRACT.modes.find((mode) => mode.id === "free-local-oss")!;
  expect(free.costToMatematicaUser).toBe("free");
  expect(free.networkDefault).toBe("zero-network");
  expect(free.requires).toContain("no provider keys");
  expect(free.forbidden).toContain("remote model dispatch");
  expect(free.forbidden).toContain("bundled provider credits");

  const byok = EXECUTION_CONTRACT.modes.find((mode) => mode.id === "paid-byok-remote")!;
  expect(byok.costToMatematicaUser).toBe("provider-billed-byok");
  expect(byok.requires).toContain("--max-call-usd");
  expect(byok.requires).toContain("--max-output-tokens");
  expect(byok.requires).toContain("ledgered remote compute admission");
  expect(byok.forbidden).toContain("unledgered paid remote call");
  expect(byok.forbidden).toContain("treating model output as verifier-backed final evidence");
});

test("contract CLI renders text and JSON execution contract", async () => {
  const text = await runCli(["contract", "show"]);
  expect(text).toBe(formatExecutionContract());
  expect(text).toContain("free-local-oss");
  expect(text).toContain("paid-byok-remote");

  const json = JSON.parse(await runCli(["contract", "show", "--json"]));
  expect(json.format).toBe("matematica.execution-contract");
  expect(json.modes).toHaveLength(2);
  expect(JSON.stringify(json)).toContain("--i-understand-remote-costs");
});
