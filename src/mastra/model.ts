import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// DeepSeek exposes an OpenAI-compatible Chat Completions API, so we point
// the generic openai-compatible provider at DeepSeek's base URL instead of
// using a DeepSeek-specific SDK.
const deepseek = createOpenAICompatible({
  name: "deepseek",
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
});

// "deepseek-chat" was the model name at the time this was written, but
// DeepSeek has since retired it — current valid names are deepseek-v4-pro
// and deepseek-v4-flash. Defaulting to the new name here so a fresh clone
// without DEEPSEEK_MODEL set in .env doesn't hit the same "invalid_req
// uest_error" this default used to cause.
export const outreachModel = deepseek(process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash");
