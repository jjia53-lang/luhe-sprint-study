const origin = "https://jjia53-lang.github.io";

function httpHandler(handle) {
  return async function main(event = {}) {
    const method = event.httpMethod ?? event.requestContext?.http?.method ?? event.requestContext?.httpMethod
      ?? event.method ?? (typeof event.body === "string" ? "POST" : undefined);
    if (!method) return handle(event);

    const allowed = Object.entries(event.headers ?? {}).some(([key, value]) => key.toLowerCase() === "origin" && value === origin);
    const headers = {
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store",
      "Vary":"Origin",
      ...(allowed ? {
        "Access-Control-Allow-Origin":origin,
        "Access-Control-Allow-Methods":"POST, OPTIONS",
        "Access-Control-Allow-Headers":"Content-Type",
      } : {}),
    };
    const reply = (statusCode, payload) => ({
      statusCode, headers, isBase64Encoded:false, body:payload ? JSON.stringify(payload) : "",
    });
    if (method === "OPTIONS") return reply(allowed ? 204 : 403);
    if (method !== "POST") return reply(405, {ok:false,error:"不支持此操作。"});
    if (typeof event.body !== "string" || event.body.length > 32000) return reply(400, {ok:false,error:"提交的数据格式不正确。"});
    let payload;
    try {
      const body = event.isBase64Encoded ? Buffer.from(event.body,"base64").toString("utf8") : event.body;
      payload = JSON.parse(body);
    } catch {
      return reply(400, {ok:false,error:"提交的数据格式不正确。"});
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return reply(400, {ok:false,error:"提交的数据格式不正确。"});
    }
    try {
      const result = await handle(payload);
      return reply(result.ok ? 200 : 403, result);
    } catch {
      return reply(500, {ok:false,error:"云端暂时无法保存，请稍后重试。"});
    }
  };
}

module.exports = { httpHandler };
