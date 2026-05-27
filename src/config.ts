import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { providerCapabilityFor, providerCapabilitySummary } from "./provider-capabilities";
import { redactText } from "./redaction";

export type ProviderName = "openai" | "anthropic" | "openrouter" | "cerebras" | "local";

export type ProviderConfig = {
  name: ProviderName;
  apiKeyEnv?: string;
  baseUrlEnv?: string;
  modelEnv?: string;
  defaultModel: string;
  configured: boolean;
  redactedApiKey?: string;
  baseUrl?: string;
  model: string;
};

export type MatematicaConfig = {
  defaultWorkflow: "pflk" | "gree";
  defaultMaxWorkers: number;
  localOnly: boolean;
  providers: ProviderConfig[];
};

const PROVIDERS: Array<Omit<ProviderConfig, "configured" | "redactedApiKey" | "baseUrl" | "model">> = [
  { name: "openai", apiKeyEnv: "OPENAI_API_KEY", modelEnv: "MATEMATICA_OPENAI_MODEL", defaultModel: "gpt-5.2" },
  { name: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY", modelEnv: "MATEMATICA_ANTHROPIC_MODEL", defaultModel: "claude-opus-4-1-20250805" },
  { name: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", modelEnv: "MATEMATICA_OPENROUTER_MODEL", defaultModel: "openai/gpt-5.2" },
  { name: "cerebras", apiKeyEnv: "CEREBRAS_API_KEY", modelEnv: "MATEMATICA_CEREBRAS_MODEL", defaultModel: "gpt-oss-120b" },
  { name: "local", baseUrlEnv: "MATEMATICA_LOCAL_BASE_URL", modelEnv: "MATEMATICA_LOCAL_MODEL", defaultModel: "llama3.1" }
];

export function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): MatematicaConfig {
  const fileConfig = readConfigFile(root);
  const defaultWorkflow = fileConfig.defaultWorkflow === "gree" ? "gree" : "pflk";
  const defaultMaxWorkers = numberFrom(fileConfig.defaultMaxWorkers, 1);
  const localOnly = booleanFrom(env.MATEMATICA_LOCAL_ONLY) ?? booleanFrom(fileConfig.localOnly) ?? false;

  return {
    defaultWorkflow,
    defaultMaxWorkers,
    localOnly,
    providers: PROVIDERS.map((provider) => {
      const apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined;
      const baseUrl = provider.baseUrlEnv ? env[provider.baseUrlEnv] : undefined;
      const model = provider.modelEnv ? env[provider.modelEnv] ?? provider.defaultModel : provider.defaultModel;
      return {
        ...provider,
        configured: provider.name === "local" ? Boolean(baseUrl) : Boolean(apiKey),
        redactedApiKey: apiKey ? redactSecret(apiKey) : undefined,
        baseUrl,
        model
      };
    })
  };
}

export function publicConfig(config: MatematicaConfig): MatematicaConfig {
  return {
    ...config,
    providers: config.providers.map((provider) => ({
      name: provider.name,
      apiKeyEnv: provider.apiKeyEnv,
      baseUrlEnv: provider.baseUrlEnv,
      modelEnv: provider.modelEnv,
      defaultModel: provider.defaultModel,
      configured: provider.configured,
      redactedApiKey: provider.redactedApiKey,
      baseUrl: provider.baseUrl ? redactText(provider.baseUrl) : undefined,
      model: provider.model
    }))
  };
}

export function redactSecret(secret: string): string {
  void secret;
  return "<redacted>";
}

export function providerSummary(config: MatematicaConfig): string[] {
  return config.providers.map((provider) => {
    const status = provider.configured ? "configured" : "missing";
    const key = provider.redactedApiKey ? ` key=${provider.redactedApiKey}` : "";
    const baseUrl = provider.baseUrl ? ` baseUrl=${redactText(provider.baseUrl)}` : "";
    const capability = providerCapabilitySummary(providerCapabilityFor(provider));
    return `${provider.name}: ${status} model=${provider.model}${key}${baseUrl} ${capability}`;
  });
}

function readConfigFile(root: string): Record<string, unknown> {
  const configPath = join(root, "config.json");
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config file at ${configPath}: expected JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function numberFrom(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function booleanFrom(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  }
  return undefined;
}
