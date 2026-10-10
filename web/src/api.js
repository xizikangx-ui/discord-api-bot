let csrf = "";
export const id = () => crypto.randomUUID();
export function setCsrf(value) {
  csrf = value;
}
export async function api(path, body) {
  const r = await fetch("/api/web/v1" + path, {
    method: body === undefined ? "GET" : "POST",
    signal: AbortSignal.timeout(20000),
    headers:
      body === undefined
        ? {}
        : { "content-type": "application/json", "x-web-csrf": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let result;
  try {
    result = await r.json();
  } catch {
    throw Error("连接暂时不可用，输入已保留。");
  }
  if (!r.ok)
    throw Object.assign(
      Error(result.error?.message || "请求失败。"),
      result.error,
    );
  return result.data;
}
export const mediaUrl = (id) => "/api/web/v1/media/" + id;
