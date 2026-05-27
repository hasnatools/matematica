import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts";
import { loadConfig } from "../src/config";
import { generateInstrumentedText as rawGenerateInstrumentedText, type InstrumentedTextCall } from "../src/ai/instrumented";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";
import { admitRemoteCompute } from "../src/remote-admission";
import { buildAiSdkLoopReplayHarness, buildReplayManifest, replayOffline } from "../src/replay";

const homes: string[] = [];

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  delete process.env.OPENAI_API_KEY;
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

test("manual and ToolLoop-style AI workers produce equivalent canonical replay shapes", async () => {
  const { ledger, artifacts, runId, close } = setup();
  try {
    await admittedGenerate({
      runId,
      ledger,
      artifacts,
      idempotencyKey: "manual-loop-call",
      generate: async ({ onStepFinish }) => {
        await onStepFinish?.(toolCallStep());
        await onStepFinish?.(toolResultStep());
        return loopResult();
      }
    });
    await admittedGenerate({
      runId,
      ledger,
      artifacts,
      idempotencyKey: "toolloop-agent-style-call",
      generate: async () => ({
        ...loopResult(),
        steps: [toolCallStep(), toolResultStep()]
      })
    });

    const harness = buildAiSdkLoopReplayHarness(ledger.listEvents(runId), ledger.listArtifacts(runId));
    expect(harness.calls).toHaveLength(2);
    expect(harness.equivalentCanonicalShape).toBe(true);
    expect(new Set(harness.canonicalShapeHashes).size).toBe(1);
    for (const call of harness.calls) {
      expect(call.canonicalShape).toMatchObject({
        started: true,
        terminalStatus: "completed",
        terminalEventType: "ai.call.completed",
        stepCount: 2,
        streamChunkCount: 2,
        finishReason: "stop",
        usageKeys: ["inputTokens", "outputTokens", "totalTokens"],
        usageTotalTokens: 12,
        toolCallCount: 1,
        toolResultCount: 1,
        steps: [
          expect.objectContaining({ index: 0, toolCallCount: 1, toolResultCount: 0, hasPrepareStepChanges: true }),
          expect.objectContaining({ index: 1, toolCallCount: 0, toolResultCount: 1 })
        ],
        streamChunks: [
          expect.objectContaining({ index: 0, chunkType: "text-delta", hasTextDelta: true }),
          expect.objectContaining({ index: 1, chunkType: "finish", finishReason: "stop" })
        ]
      });
      expect(call.requestArtifactHash).toMatch(/^[a-f0-9]{64}$/);
      expect(call.responseArtifactHash).toMatch(/^[a-f0-9]{64}$/);
      expect(call.transcriptArtifactHash).toMatch(/^[a-f0-9]{64}$/);
      expect(call.stepArtifactHashes).toHaveLength(2);
      expect(call.streamChunkArtifactHashes).toHaveLength(2);
    }

    const manifest = buildReplayManifest({ runId, ledger, cwd: process.cwd(), config: loadConfig(process.cwd()) });
    expect(manifest.aiSdkLoopModes).toMatchObject({
      format: "matematica.ai-sdk-loop-replay-harness",
      equivalentCanonicalShape: true
    });
    const deterministic = replayOffline({ runId, ledger, cwd: process.cwd(), config: loadConfig(process.cwd()), deterministic: true });
    expect(deterministic.ok).toBe(true);
    expect(deterministic.deterministic?.aiSdkLoopModes.equivalentCanonicalShape).toBe(true);
  } finally {
    close();
  }
});

test("AI loop replay harness captures failed terminal state with persisted step artifacts", async () => {
  const { ledger, artifacts, runId, close } = setup();
  try {
    await expect(admittedGenerate({
      runId,
      ledger,
      artifacts,
      idempotencyKey: "failed-loop-call",
      generate: async ({ onStepFinish }) => {
        await onStepFinish?.(toolCallStep());
        throw new Error("provider tool loop failed after first step");
      }
    })).rejects.toThrow("provider tool loop failed");

    const harness = buildAiSdkLoopReplayHarness(ledger.listEvents(runId), ledger.listArtifacts(runId));
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0].canonicalShape).toMatchObject({
      started: true,
      terminalStatus: "failed",
      terminalEventType: "ai.call.failed",
      stepCount: 1,
      streamChunkCount: 0,
      errorName: "Error"
    });
    expect(harness.calls[0].errorArtifactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.calls[0].transcriptArtifactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.calls[0].stepArtifactHashes).toHaveLength(1);
  } finally {
    close();
  }
});

function setup(): { ledger: Ledger; artifacts: ArtifactStore; runId: string; close: () => void } {
  const home = mkdtempSync(join(tmpdir(), "matematica-ai-loop-replay-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  process.env.OPENAI_API_KEY = "sk-test-ai-loop-replay";
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Compare AI SDK loop replay modes",
    goal: "Persist canonical loop replay shape",
    successCriteria: ["loop traces are replay-equivalent"],
    workflow: "pflk",
    budget: { maxAttempts: 10, maxTokens: 2_000, maxUsd: 1, maxWorkers: 1 }
  });
  return {
    ledger,
    artifacts,
    runId: run.id,
    close: () => ledger.close()
  };
}

async function admittedGenerate(input: {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  idempotencyKey: string;
  generate: InstrumentedTextCall["generate"];
}) {
  const admission = admitRemoteCompute({
    runId: input.runId,
    ledger: input.ledger,
    artifacts: input.artifacts,
    command: "ai.generateText",
    provider: "openai",
    modelId: "fake-loop-replay-model",
    localOnly: false,
    maxWorkers: 1,
    maxAttempts: 10,
    runMaxUsd: 1,
    runMaxTokens: 2_000,
    maxCallUsd: 0.01,
    maxOutputTokens: 32,
    explicitRemoteConsent: true
  });
  if (!admission.ok) throw new Error(admission.reason);
  return rawGenerateInstrumentedText({
    runId: input.runId,
    ledger: input.ledger,
    artifacts: input.artifacts,
    provider: "openai",
    modelId: "fake-loop-replay-model",
    model: {} as never,
    prompt: "Use a deterministic tool loop.",
    settings: { maxOutputTokens: 32, maxUsd: 0.01 },
    idempotencyKey: input.idempotencyKey,
    generate: input.generate
  });
}

function toolCallStep() {
  return {
    finishReason: "tool-calls",
    usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    messages: [{ role: "assistant", content: "calling modular_tool" }],
    toolCalls: [{ toolCallId: "tool-1", toolName: "modular_tool", args: { n: 17 } }],
    toolResults: [],
    prepareStepResult: { activeTools: ["modular_tool"], model: "fake-loop-replay-model" }
  };
}

function toolResultStep() {
  return {
    finishReason: "stop",
    usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 },
    messages: [{ role: "tool", content: "17 mod 5 = 2" }],
    toolCalls: [],
    toolResults: [{ toolCallId: "tool-1", toolName: "modular_tool", result: { remainder: 2 } }]
  };
}

function loopResult() {
  return {
    text: "The tool returned remainder 2.",
    usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
    finishReason: "stop",
    stopCondition: { stopWhen: "stepCountIs(2)", reason: "tool loop completed" },
    streamChunks: [
      { type: "text-delta", textDelta: "The tool returned " },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 } }
    ],
    providerMetadata: {},
    toolCalls: [{ toolCallId: "tool-1", toolName: "modular_tool" }],
    toolResults: [{ toolCallId: "tool-1", result: { remainder: 2 } }]
  };
}
