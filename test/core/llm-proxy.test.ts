import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { parseConfig } from "../../src/core/config.js";
import { createProxyFetch } from "../../src/core/llm/proxy.js";
import { createOpenRouterClient, checkBalance } from "../../src/core/llm/providers/openrouter.js";
import { LLMRouter } from "../../src/core/llm/router.js";

const API_KEY = "sk-secret-key-must-never-leak";
const PROXY_LOGIN = "proxyuser";
const PROXY_PASSWORD = "pr0xy-p4ssw0rd";

/** A forward proxy that answers every proxied request itself. Plain-HTTP
 *  targets reach it as absolute-URI requests, HTTPS targets as CONNECT. */
function startProxy() {
  const requests: Array<{ url: string; auth: string | undefined }> = [];
  const connects: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? "", auth: req.headers["proxy-authorization"] as string | undefined });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }));
  });
  server.on("connect", (req, socket) => {
    connects.push(req.url ?? "");
    socket.destroy();
  });

  const ready = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://${PROXY_LOGIN}:${PROXY_PASSWORD}@127.0.0.1:${port}`);
    });
  });

  return { requests, connects, ready, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!();
});

async function proxy() {
  const p = startProxy();
  servers.push(p.close);
  return { ...p, url: await p.ready };
}

describe("llm proxy — config schema", () => {
  it("keeps proxy in the flat llm config", () => {
    const config = parseConfig({
      agent: { name: "Betsy" },
      llm: { provider: "openrouter", api_key: API_KEY, fast_model: "a/fast", proxy: "http://user:pass@host:3128" },
    });
    expect((config.llm as Record<string, unknown>).proxy).toBe("http://user:pass@host:3128");
  });

  it("keeps proxy in the nested (fast/strong) llm config", () => {
    const config = parseConfig({
      agent: { name: "Betsy" },
      llm: {
        fast: { provider: "openrouter", model: "a/fast", api_key: API_KEY, proxy: "socks5://user:pass@host:1080" },
        strong: { provider: "openrouter", model: "a/strong", api_key: API_KEY, proxy: "socks5://user:pass@host:1080" },
      },
    });
    const llm = config.llm as { fast?: { proxy?: string } };
    expect(llm.fast?.proxy).toBe("socks5://user:pass@host:1080");
  });

  it("leaves proxy undefined when it is not configured", () => {
    const config = parseConfig({
      agent: { name: "Betsy" },
      llm: { provider: "openrouter", api_key: API_KEY, fast_model: "a/fast" },
    });
    expect((config.llm as Record<string, unknown>).proxy).toBeUndefined();
  });
});

describe("llm proxy — fetch factory", () => {
  it("builds nothing when no proxy is configured", () => {
    expect(createProxyFetch(undefined)).toBeUndefined();
    expect(createProxyFetch("   ")).toBeUndefined();
  });

  it("accepts a socks5 address", () => {
    expect(createProxyFetch("socks5://user:pass@127.0.0.1:1080")).toBeTypeOf("function");
  });

  it("rejects an address with an unsupported scheme without quoting it", () => {
    let message = "";
    try {
      createProxyFetch("ftp://user:pass@127.0.0.1:21");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("llm.proxy");
    expect(message).not.toContain("pass");
    expect(message).not.toContain("127.0.0.1");
  });
});

describe("llm proxy — requests", () => {
  it("sends chat requests through the proxy, with its credentials", async () => {
    const p = await proxy();
    const client = createOpenRouterClient({
      apiKey: API_KEY,
      model: "a/fast",
      baseURL: "http://llm.invalid/v1",
      proxy: p.url,
    });

    const res = await client.chat([{ role: "user", content: "hi" }]);

    expect(res.text).toBe("ok");
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0]!.url).toBe("http://llm.invalid/v1/chat/completions");
    const auth = Buffer.from(p.requests[0]!.auth!.replace("Basic ", ""), "base64").toString();
    expect(auth).toBe(`${PROXY_LOGIN}:${PROXY_PASSWORD}`);
  });

  it("routes requests through the proxy configured on the router", async () => {
    const p = await proxy();
    const router = new LLMRouter({
      provider: "openrouter",
      api_key: API_KEY,
      fast_model: "a/fast",
      strong_model: "a/strong",
      base_url: "http://llm.invalid/v1",
      proxy: p.url,
    });

    await router.fast().chat([{ role: "user", content: "hi" }]);
    router.destroy();

    expect(p.requests.map((r) => r.url)).toEqual(["http://llm.invalid/v1/chat/completions"]);
  });

  it("sends the balance check through the proxy as well", async () => {
    const p = await proxy();
    const proxyFetch = createProxyFetch(p.url)!;

    // The proxy tears the tunnel down, so the call fails — what matters is
    // that OpenRouter was reached for through the proxy and not directly.
    await checkBalance(API_KEY, undefined, proxyFetch).catch(() => undefined);

    expect(p.connects).toEqual(["openrouter.ai:443"]);
  });
});

/** Everything an operator could see of a thrown error: message, stack, own
 *  fields, and the cause chain — where the underlying fetch hides the target. */
function errorText(err: unknown, depth = 0): string {
  if (!(err instanceof Error) || depth > 4) return String(err);
  return [
    err.message,
    err.stack ?? "",
    JSON.stringify(err, Object.getOwnPropertyNames(err)),
    errorText((err as { cause?: unknown }).cause, depth + 1),
  ].join(" ");
}

describe("llm proxy — secrets", () => {
  // Port 1 refuses connections, so the failure happens on the proxy hop and
  // the raw error would otherwise quote the proxy address.
  const DEAD_PROXY_HOST = "127.0.0.1:1";

  it("keeps the proxy address and the api key out of chat failures", async () => {
    const client = createOpenRouterClient({
      apiKey: API_KEY,
      model: "a/fast",
      baseURL: "http://llm.invalid/v1",
      proxy: `http://${PROXY_LOGIN}:${PROXY_PASSWORD}@${DEAD_PROXY_HOST}`,
    });

    const err = await client.chat([{ role: "user", content: "hi" }]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const text = errorText(err);
    expect(text).not.toContain(PROXY_LOGIN);
    expect(text).not.toContain(PROXY_PASSWORD);
    expect(text).not.toContain(DEAD_PROXY_HOST);
    expect(text).not.toContain(API_KEY);
  });

  it("keeps the proxy address out of balance check failures", async () => {
    const proxyFetch = createProxyFetch(`socks5://${PROXY_LOGIN}:${PROXY_PASSWORD}@${DEAD_PROXY_HOST}`)!;

    const err = await checkBalance(API_KEY, undefined, proxyFetch).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const text = errorText(err);
    expect(text).not.toContain(PROXY_LOGIN);
    expect(text).not.toContain(PROXY_PASSWORD);
    expect(text).not.toContain(DEAD_PROXY_HOST);
    expect(text).not.toContain(API_KEY);
  });
});
