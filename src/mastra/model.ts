import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// DeepSeek exposes an OpenAI-compatible Chat Completions API, so we point
// the generic openai-compatible provider at DeepSeek's base URL instead of
// using a DeepSeek-specific SDK.
const deepseek = createOpenAICompatible({
  name: "deepseek",
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
});

export const outreachModel = deepseek(process.env.DEEPSEEK_MODEL ?? "deepseek-chat");
