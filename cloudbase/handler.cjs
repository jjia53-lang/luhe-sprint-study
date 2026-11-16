const { createHash, timingSafeEqual } = require("node:crypto");
const hash = value => createHash("sha256").update(value).digest();
const validDate = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value
    && value >= "2026-11-16";
};

function getRole(token, secrets) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const digest = hash(token);
  for (const [role, expected] of Object.entries(secrets)) {
    if (/^[0-9a-f]{64}$/.test(expected ?? "") && timingSafeEqual(digest, Buffer.from(expected, "hex"))) return role;
  }
  return null;
}

function completion(value) {
  if (!value || !validDate(value.date) || !Number.isInteger(value.minutes)
      || value.minutes < 1 || value.minutes > 600 || typeof value.revision !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.revision)
      || !Number.isFinite(Date.parse(value.revision))) return null;
  const { date, minutes, revision } = value;
  if (value.kind === "vocab") return { date, minutes, revision, kind:"vocab", itemId:"words" };
  if (value.kind !== "task" || typeof value.itemId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(value.itemId)
      || typeof value.title !== "string" || !value.title.trim() || value.title.length > 140
      || !["数学","英语","其他"].includes(value.subject)) return null;
  return { date, minutes, revision, kind:"task", itemId:value.itemId, title:value.title.trim(), subject:value.subject };
}

function createHandler(store, secrets) {
  return async function main(event = {}) {
    const role = getRole(event.token, secrets);
    if (!role) return { ok:false, error:"访问链接无效。" };
    switch (event.action) {
      case "connect":
        return { ok:true, role };
      case "save": {
        if (role !== "student") return { ok:false, error:"家长链接只有查看权限。" };
        const entries = Array.isArray(event.entries) && event.entries.length <= 20 && event.entries.map(completion);
        if (!entries?.length || entries.includes(null)) return { ok:false, error:"提交的数据格式不正确。" };
        for (const entry of entries) {
          // Retries use the same document ID, and older revisions cannot overwrite a newer event.
          const id = hash(JSON.stringify(entry)).toString("hex").slice(0, 32);
          await store.put(id, entry);
        }
        return { ok:true, count:entries.length };
      }
      case "day": {
        if (!validDate(event.date)) return { ok:false, error:"请选择冲刺期间的日期。" };
        const entries = await store.day(event.date);
        const latest = new Map();
        for (const entry of entries) {
          const key = entry.kind + ":" + entry.itemId;
          if (!latest.has(key) || latest.get(key).revision <= entry.revision) latest.set(key, entry);
        }
        return { ok:true, entries:[...latest.values()] };
      }
      default:
        return { ok:false, error:"不支持此操作。" };
    }
  };
}
module.exports = { createHandler };
