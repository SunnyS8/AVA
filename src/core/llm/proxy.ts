import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

/**
 * Routing model requests through an HTTP or SOCKS5 proxy.
 *
 * Node 22 — the version running in production — has no proxy support in its
 * built-in fetch (that landed in Node 24), so the request has to carry an
 * undici dispatcher of its own.
 *
 * A proxy address is a live credential: `http://login:password@host:port`.
 * It must never reach a log line or the text of an exception, exactly like the
 * model key. Hence nothing here ever puts the address into a message, and
 * network failures leave this module carrying only the error kind — the
 * underlying fetch bakes the request target into its own messages.
 */

const SUPPORTED_PROTOCOLS = new Set(["http:", "https:", "socks:", "socks5:"]);

/** Dispatchers are pooled: one per address, reused by every client and by the
 *  periodic balance check, so connections are not re-established each time. */
const dispatchers = new Map<string, Dispatcher>();

function getDispatcher(proxyUrl: string): Dispatcher {
  const cached = dispatchers.get(proxyUrl);
  if (cached) return cached;

  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error("llm.proxy is not a valid URL (expected scheme://login:password@host:port)");
  }

  // socks5h means "resolve the host name at the proxy" — which is what undici
  // does for socks5 anyway.
  const protocol = parsed.protocol === "socks5h:" ? "socks5:" : parsed.protocol;
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new Error("llm.proxy uses an unsupported scheme (expected http, https or socks5)");
  }
  parsed.protocol = protocol;

  const dispatcher = new ProxyAgent({ uri: parsed.href });
  dispatchers.set(proxyUrl, dispatcher);
  return dispatcher;
}

/**
 * Build a fetch that goes through the given proxy, or undefined when no proxy
 * is configured — the caller then keeps its ordinary direct fetch.
 */
export function createProxyFetch(proxyUrl?: string): typeof fetch | undefined {
  const address = proxyUrl?.trim();
  if (!address) return undefined;

  const dispatcher = getDispatcher(address);

  const proxied = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      return await undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher },
      ) as unknown as Response;
    } catch (err) {
      // Only the error kind may leave: a connection failure through the proxy
      // otherwise quotes the address, credentials and all.
      throw new Error(`LLM request through proxy failed: ${(err as Error).name}`);
    }
  };

  return proxied as typeof fetch;
}
