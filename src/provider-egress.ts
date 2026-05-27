import type { ProviderName } from "./config";
import { collectSecretValues, redactText } from "./redaction";
import { isRemoteProvider } from "./privacy";

export type ProviderEgressSettings = {
  temperature?: number;
  maxOutputTokens?: number;
  timeout?: number;
};

export type ProviderEgressPayload = {
  provider: ProviderName;
  modelId: string;
  prompt: string;
  settings: ProviderEgressSettings;
};

export type ProviderEgressCheck = {
  ok: boolean;
  provider: ProviderName;
  modelId: string;
  remote: boolean;
  allowedFields: string[];
  redactedSecretCount: number;
  redactedLocalPathCount: number;
  blockedLedgerInternals: string[];
  promptChanged: boolean;
  sanitizedPrompt: string;
  settings: ProviderEgressSettings;
};

const LEDGER_INTERNAL_PATTERNS = [
  /matematica\.sqlite/i,
  /sqlite_sequence/i,
  /external_operations/i,
  /budget_reservations/i
];

const LOCAL_PATH_PATTERNS = [
  /\/home\/[^\s"'<>]+/g,
  /\/Users\/[^\s"'<>]+/g,
  /\/tmp\/[^\s"'<>]+/g,
  /file:\/\/[^\s"'<>]+/g
];

export function prepareProviderEgress(input: ProviderEgressPayload): ProviderEgressCheck {
  const remote = isRemoteProvider(input.provider);
  const secretValues = collectSecretValues();
  const blockedLedgerInternals = remote
    ? LEDGER_INTERNAL_PATTERNS
      .filter((pattern) => pattern.test(input.prompt))
      .map((pattern) => pattern.source)
    : [];
  if (blockedLedgerInternals.length > 0) {
    return {
      ok: false,
      provider: input.provider,
      modelId: input.modelId,
      remote,
      allowedFields: allowedFields(),
      redactedSecretCount: countSecretOccurrences(input.prompt, secretValues),
      redactedLocalPathCount: 0,
      blockedLedgerInternals,
      promptChanged: false,
      sanitizedPrompt: "",
      settings: sanitizedSettings(input.settings)
    };
  }
  const afterSecrets = redactText(input.prompt);
  const pathRedaction = redactLocalPaths(afterSecrets);
  return {
    ok: true,
    provider: input.provider,
    modelId: input.modelId,
    remote,
    allowedFields: allowedFields(),
    redactedSecretCount: countSecretOccurrences(input.prompt, secretValues),
    redactedLocalPathCount: pathRedaction.count,
    blockedLedgerInternals,
    promptChanged: pathRedaction.text !== input.prompt,
    sanitizedPrompt: pathRedaction.text,
    settings: sanitizedSettings(input.settings)
  };
}

function allowedFields(): string[] {
  return ["model", "prompt", "temperature", "maxOutputTokens", "abortSignal", "timeout", "onStepFinish"];
}

function sanitizedSettings(settings: ProviderEgressSettings): ProviderEgressSettings {
  return {
    temperature: settings.temperature,
    maxOutputTokens: settings.maxOutputTokens,
    timeout: settings.timeout
  };
}

function countSecretOccurrences(input: string, secrets: string[]): number {
  return secrets.reduce((count, secret) => count + occurrences(input, secret), 0);
}

function occurrences(input: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = input.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = input.indexOf(needle, index + needle.length);
  }
  return count;
}

function redactLocalPaths(input: string): { text: string; count: number } {
  let text = input;
  let count = 0;
  const redact = (_match: string) => {
    count += 1;
    return "<redacted-local-path>";
  };
  for (const pattern of LOCAL_PATH_PATTERNS) {
    text = text.replace(pattern, redact);
  }
  return { text, count };
}
