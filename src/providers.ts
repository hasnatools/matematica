import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { MatematicaConfig, ProviderName } from "./config";
import { providerCapabilityFor, type ProviderCapabilityRecord } from "./provider-capabilities";

export type ModelRef = {
  provider: ProviderName;
  modelId?: string;
};

export type ResolvedModel = {
  provider: ProviderName;
  modelId: string;
  model: LanguageModel;
  capabilities: ProviderCapabilityRecord;
};

export function resolveModel(
  config: MatematicaConfig,
  ref: ModelRef,
  env: NodeJS.ProcessEnv = process.env
): ResolvedModel {
  const provider = config.providers.find((candidate) => candidate.name === ref.provider);
  if (!provider) throw new Error(`Unknown provider: ${ref.provider}`);
  if (!provider.configured) throw new Error(`Provider is not configured: ${ref.provider}`);
  if (config.localOnly && ref.provider !== "local") {
    throw new Error(`MATEMATICA_LOCAL_ONLY blocks remote provider: ${ref.provider}`);
  }

  const modelId = ref.modelId ?? provider.model;
  const capabilities = providerCapabilityFor(provider, { requestedModel: modelId });

  switch (ref.provider) {
    case "openai": {
      const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
      return { provider: ref.provider, modelId, model: openai(modelId), capabilities };
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
      return { provider: ref.provider, modelId, model: anthropic(modelId), capabilities };
    }
    case "openrouter": {
      const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
      return { provider: ref.provider, modelId, model: openrouter(modelId), capabilities };
    }
    case "cerebras": {
      const cerebras = createCerebras({ apiKey: env.CEREBRAS_API_KEY });
      return { provider: ref.provider, modelId, model: cerebras(modelId), capabilities };
    }
    case "local": {
      if (!provider.baseUrl) throw new Error("Local provider requires MATEMATICA_LOCAL_BASE_URL.");
      const local = createOpenAICompatible({
        name: "matematica-local",
        baseURL: provider.baseUrl,
        apiKey: env.MATEMATICA_LOCAL_API_KEY,
        includeUsage: true
      });
      return { provider: ref.provider, modelId, model: local(modelId), capabilities };
    }
  }
}

export function configuredProviderNames(config: MatematicaConfig): ProviderName[] {
  return config.providers
    .filter((provider) => provider.configured)
    .map((provider) => provider.name);
}
