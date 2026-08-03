function isDiscordRoute(pathname) {
  return (
    pathname === "/api/v1/discord/commands" ||
    /^\/api\/v1\/campaigns\/[0-9a-f-]{36}\/discord\/bindings(?:\/[0-9a-f-]{36}\/verify)?$/i.test(
      pathname,
    )
  );
}

export function attachDiscordSecurity(
  server,
  { corsOrigin = "http://localhost:3000", windowMs = 60_000, limit = 60 } = {},
) {
  const listeners = server.listeners("request");
  server.removeAllListeners("request");
  const buckets = new Map();

  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!isDiscordRoute(url.pathname)) {
      for (const listener of listeners) listener.call(server, request, response);
      return;
    }

    const origin = corsOrigin === "*" ? "*" : corsOrigin;
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      });
      response.end();
      return;
    }

    const key = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      bucket = { startedAt: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      response.writeHead(429, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
      });
      response.end(JSON.stringify({ error: "Rate limit exceeded" }));
      return;
    }

    for (const listener of listeners) listener.call(server, request, response);
  });

  return server;
}
