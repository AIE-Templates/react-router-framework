/**
 * The request as the browser addressed it, behind a reverse proxy that terminates TLS: the scheme
 * and host come from X-Forwarded-Proto/-Host (first value each). Only use it when a proxy sets these
 * headers, since clients reaching the server directly could forge them.
 */
export function withForwardedOrigin(request: Request): Request {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (!proto && !host) return request;
  const url = new URL(request.url);
  if (proto === "http" || proto === "https") url.protocol = proto;
  if (host) {
    // A host without a port must not keep the internal one (e.g. Host: app:3000).
    url.port = "";
    url.host = host;
  }
  // The Node adapter's request is not a native Request: passing it as init invokes native
  // getters (such as duplex) with an incompatible receiver. Copy only the fields we need.
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? request.body : null,
    signal: request.signal,
    ...(hasBody ? { duplex: "half" } : {}),
  });
}
