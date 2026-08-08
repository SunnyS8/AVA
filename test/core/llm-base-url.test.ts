import { describe, it, expect, vi } from "vitest";
import { parseConfig } from "../../src/core/config.js";
import {
  createOpenRouterClient,
  checkBalance,
  normalizeBaseUrl,
  OPENROUTER_BASE_URL,
} from "../../src/core/llm/providers/openrouter.js";
import { LLMRouter } from "../../src/core/llm/router.js";

const API_KEY = "sk-secret-key-must-never-leak";

/** Records every URL asked for and answers with a canned chat completion. */
function recordingFetch(body: unknown = {
  id: "1",
  choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
}, status = 200) {
  const urls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { urls, impl: impl as unknown as typeof fetch };
}

describe("llm base_url — config schema", () => {
  it("keeps base_url in the flat llm config", () => {
    const config = parseConfig({
      agent: { name: "Betsy" },
      llm: {
        provider: "openrouter",
        api_key: API_KEY,
        fast_model: "a/fast",
        strong_model: "a/strong",
        base_url: "https://api.kie.ai/v1",
      },
    });
    expect((config.llm as Record<string, unknown>).base_url).toBe("https://api.kie.ai/v1");
  });

  it("keeps base_url in the nested (fast/strong) llm config", () => {
    const config = parseConfig({
      agent: { name: "Betsy" },
      llm: {
        fast: { provider: "openrouter", model: "a/fast", api_key: API_KEY, base_url: "https://api.kie.ai/v1" },
        strong: { provider: "openrouter", model: "a/strong", api_key: API_KEY, base_url: "https://api.kie.ai/v1" },
      },
    });
    const llm = config.llm as { fast?: { base_url?: string }; strong?: { base_url?: string } };
    expect(llm.fast?.base_url).toBe("https://api.kie.ai/v1");
    expect(llm.strong?.base_url).toBe("https://api.kie.ai/v1");
  });

  it("leaves base_url undefined when it is not configured", () => {
    const config = parseConfig({
      agent: { name: "Betsy" },
      llm: { provider: "openrouter", api_key: API_KEY, fast_model: "a/fast" },
    });
    expect((config.llm as Record<string, unknown>).base_url).toBeUndefined();
  });
});

describe("llm base_url — provider", () => {
  it("falls back to OpenRouter when no base_url is given", async () => {
    const { urls, impl } = recordingFetch();
    const client = createOpenRouterClient({ apiKey: API_KEY, model: "a/fast", fetchImpl: impl });
    await client.chat([{ role: "user", content: "hi" }]);
    expect(urls).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
  });

  it("sends the request to the configured base_url", async () => {
    const { urls, impl } = recordingFetch();
    const client = createOpenRouterClient({
      apiKey: API_KEY,
      model: "a/fast",
      baseURL: "https://api.kie.ai/v1",
      fetchImpl: impl,
    });
    await client.chat([{ role: "user", content: "hi" }]);
    expect(urls).toEqual(["https://api.kie.ai/v1/chat/completions"]);
  });

  it("does not produce a double slash when base_url ends with one", async () => {
    const { urls, impl } = recordingFetch();
    const client = createOpenRouterClient({
      apiKey: API_KEY,
      model: "a/fast",
      baseURL: "https://api.kie.ai/v1///",
      fetchImpl: impl,
    });
    await client.chat([{ role: "user", content: "hi" }]);
    expect(urls).toEqual(["https://api.kie.ai/v1/chat/completions"]);
  });

  it("normalizes a blank base_url back to OpenRouter", () => {
    expect(normalizeBaseUrl(undefined)).toBe(OPENROUTER_BASE_URL);
    expect(normalizeBaseUrl("  ")).toBe(OPENROUTER_BASE_URL);
    expect(normalizeBaseUrl("https://openrouter.ai/api/v1/")).toBe(OPENROUTER_BASE_URL);
  });

  it("keeps the api key out of request failure messages", async () => {
    const { impl } = recordingFetch({ error: "Access denied by security policy." }, 403);
    const client = createOpenRouterClient({
      apiKey: API_KEY,
      model: "a/fast",
      baseURL: "https://api.kie.ai/v1",
      fetchImpl: impl,
    });
    const err = await client.chat([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(JSON.stringify({ m: (err as Error).message, s: (err as Error).stack })).not.toContain(API_KEY);
  });
});

describe("llm base_url — balance check", () => {
  it("asks OpenRouter for the key status when no base_url is set", async () => {
    const { urls, impl } = recordingFetch({ data: { usage: 1, limit: 10 } });
    const info = await checkBalance(API_KEY, undefined, impl);
    expect(urls).toEqual(["https://openrouter.ai/api/v1/auth/key"]);
    expect(info?.hasBalance).toBe(true);
  });

  it("skips the key status call for a foreign base_url", async () => {
    const { urls, impl } = recordingFetch();
    const info = await checkBalance(API_KEY, "https://api.kie.ai/v1", impl);
    expect(urls).toEqual([]);
    expect(info).toBeNull();
  });

  it("keeps the api key out of balance check failures", async () => {
    const { impl } = recordingFetch({ error: "unauthorized" }, 401);
    const err = await checkBalance(API_KEY, undefined, impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(API_KEY);
  });
});

describe("llm base_url — router", () => {
  it("passes base_url down to the provider", async () => {
    const { urls, impl } = recordingFetch();
    const router = new LLMRouter({
      provider: "openrouter",
      api_key: API_KEY,
      fast_model: "a/fast",
      strong_model: "a/strong",
      base_url: "https://api.kie.ai/v1",
      fetchImpl: impl,
    });
    await router.fast().chat([{ role: "user", content: "hi" }]);
    expect(urls).toEqual(["https://api.kie.ai/v1/chat/completions"]);
    router.destroy();
  });

  it("keeps the OpenRouter address when base_url is absent", async () => {
    const { urls, impl } = recordingFetch();
    const router = new LLMRouter({
      provider: "openrouter",
      api_key: API_KEY,
      fast_model: "a/fast",
      strong_model: "a/strong",
      fetchImpl: impl,
    });
    await router.strong().chat([{ role: "user", content: "hi" }]);
    expect(urls).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
    router.destroy();
  });
});
