const { createHash, timingSafeEqual } = require("node:crypto");
const hash = value => createHash("sha256").update(value).digest();
const validDate = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value
    && value >= "2026-11-16";
};

function getAccess(token, secrets) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const digest = hash(token);
  for (const [role, expected] of Object.entries(secrets)) {
    if (/^[0-9a-f]{64}$/.test(expected ?? "") && timingSafeEqual(digest, Buffer.from(expected, "hex"))) return { role:role.replace(/^test-/, ""), scope:role.startsWith("test-") ? "test" : "family" };
  }
  return null;
}

function completion(value) {
  if (!value || !validDate(value.date) || !Number.isInteger(value.minutes)
      || value.minutes < 1 || value.minutes > 600 || typeof value.revision !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.revision)
      || !Number.isFinite(Date.parse(value.revision))) return null;
  const { date, minutes, revision } = value;
  if (value.notes !== undefined && (typeof value.notes !== "string" || value.notes.length > 1000)) return null;
  const notes = typeof value.notes === "string" ? value.notes.trim() : "";
  if (value.kind === "vocab") return { date, minutes, revision, kind:"vocab", itemId:"words", ...(notes ? {notes} : {}) };
  if (value.kind !== "task" || typeof value.itemId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(value.itemId)
      || typeof value.title !== "string" || !value.title.trim() || value.title.length > 140
      || !["数学","英语","其他"].includes(value.subject)) return null;
  return { date, minutes, revision, kind:"task", itemId:value.itemId, title:value.title.trim(), subject:value.subject, ...(notes ? {notes} : {}) };
}

const revisionPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const idPattern = /^[a-zA-Z0-9-]{1,100}$/;
const maxFile = 8 * 1024 * 1024;
// The free CloudBase plan stops a function after 3 seconds, so every call does a small, bounded amount of work.
const chunkSize = 600000;
const isObject = value => !!value && typeof value === "object" && !Array.isArray(value);

// Study records keep the latest copy per record; data stays an opaque object owned by the page.
function studyRecord(value) {
  if (!isObject(value) || !["log","mistake","word","task","settings","attachment","review"].includes(value.type)) return null;
  const { type, id, rev, deleted } = value;
  if (typeof id !== "string" || !(type === "word" ? id.length >= 1 && id.length <= 200 : type === "settings" ? id === "exam" : idPattern.test(id))) return null;
  if (typeof rev !== "string" || !revisionPattern.test(rev) || !Number.isFinite(Date.parse(rev)) || typeof deleted !== "boolean") return null;
  if (deleted) return { type, id, rev, deleted, data:null };
  if (!isObject(value.data) || JSON.stringify(value.data).length > 20000) return null;
  if (type === "review") {
    const { taskId, rating, comment, createdAt } = value.data;
    if ((taskId !== null && (typeof taskId !== "string" || !idPattern.test(taskId))) || !["已确认","建议补充","留言"].includes(rating)
        || typeof comment !== "string" || !comment.trim() || comment.length > 3000 || createdAt !== rev) return null;
    return { type, id, rev, deleted, data:{ taskId, rating, comment:comment.trim(), author:"家长", createdAt } };
  }
  if (type === "attachment") {
    const { taskId, name, size, type:mime } = value.data;
    if (typeof taskId !== "string" || !idPattern.test(taskId) || typeof name !== "string" || !name || name.length > 200
        || !Number.isInteger(size) || size < 1 || size > maxFile || typeof mime !== "string" || mime.length > 100) return null;
    return { type, id, rev, deleted, data:{ taskId, name, size, type:mime } };
  }
  return { type, id, rev, deleted, data:value.data };
}

function createHandler(store, secrets) {
  return async function main(event = {}) {
    const access = getAccess(event.token, secrets);
    if (!access) return { ok:false, error:"访问链接无效。" };
    const {role,scope} = access;
    switch (event.action) {
      case "connect":
        return { ok:true, role };
      case "save": {
        if (role !== "student") return { ok:false, error:"家长链接只有查看权限。" };
        const entries = Array.isArray(event.entries) && event.entries.length <= 20 && event.entries.map(completion);
        if (!entries?.length || entries.includes(null)) return { ok:false, error:"提交的数据格式不正确。" };
        for (const entry of entries) {
          // Retries use the same document ID, and older revisions cannot overwrite a newer event.
          const id = hash(scope + JSON.stringify(entry)).toString("hex").slice(0, 32);
          await store.put(id, entry, scope);
        }
        return { ok:true, count:entries.length };
      }
      case "day": {
        if (!validDate(event.date)) return { ok:false, error:"请选择冲刺期间的日期。" };
        const entries = await store.day(event.date, scope);
        const latest = new Map();
        for (const entry of entries) {
          const key = entry.kind + ":" + entry.itemId;
          if (!latest.has(key) || latest.get(key).revision <= entry.revision) latest.set(key, entry);
        }
        return { ok:true, entries:[...latest.values()] };
      }
      case "all": {
        // Latest completion per task, and per day for word practice, across the whole sprint.
        const entries = await store.all(scope);
        const latest = new Map();
        for (const entry of entries) {
          const key = entry.kind === "vocab" ? "vocab:" + entry.date : "task:" + entry.itemId;
          if (!latest.has(key) || latest.get(key).revision <= entry.revision) latest.set(key, entry);
        }
        return { ok:true, entries:[...latest.values()] };
      }
      case "records":
        return { ok:true, records:await store.records(scope) };
      case "records.save": {
        const records = Array.isArray(event.records) && event.records.length <= 20 && event.records.map(studyRecord);
        if (!records?.length || records.includes(null)) return { ok:false, error:"提交的数据格式不正确。" };
        // The parent link may only write feedback; feedback can only come from the parent link.
        if (records.some(record => (record.type === "review") !== (role === "parent"))) {
          return { ok:false, error:role === "parent" ? "家长链接只能写评价和留言。" : "评价只能由家长链接发布。" };
        }
        const latest = new Map();
        for (const record of records) {
          const key = record.type + ":" + record.id;
          if (!latest.has(key) || latest.get(key).rev <= record.rev) latest.set(key, record);
        }
        await Promise.all([...latest.values()].map(async record => {
          const id = hash(scope + ":record:" + record.type + ":" + record.id).toString("hex").slice(0, 32);
          const existing = await store.getRecord(id);
          // An older copy arriving late never replaces a newer edit from another device.
          if (!existing || existing.rev <= record.rev) await store.putRecord(id, record, scope);
        }));
        return { ok:true, count:records.length };
      }
      case "file.put": {
        if (role !== "student") return { ok:false, error:"家长链接只有查看权限。" };
        const { file, index, total, data } = event;
        if (typeof file !== "string" || !idPattern.test(file) || !Number.isInteger(total) || total < 1 || total > Math.ceil(maxFile / chunkSize)
            || !Number.isInteger(index) || index < 0 || index >= total || typeof data !== "string" || !data
            || data.length > Math.ceil(chunkSize / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { ok:false, error:"附件格式不正确。" };
        const content = Buffer.from(data, "base64");
        if (!content.length || content.length > chunkSize) return { ok:false, error:"附件格式不正确。" };
        await store.putChunk(hash(scope + ":chunk:" + file + ":" + index).toString("hex").slice(0, 32), scope, file, index, content);
        return { ok:true };
      }
      case "file.get": {
        const { file, index } = event;
        if (typeof file !== "string" || !idPattern.test(file) || !Number.isInteger(index) || index < 0 || index >= Math.ceil(maxFile / chunkSize)) return { ok:false, error:"附件格式不正确。" };
        const content = await store.getChunk(hash(scope + ":chunk:" + file + ":" + index).toString("hex").slice(0, 32), scope);
        if (!content) return { ok:false, error:"云端还没有这份附件。" };
        return { ok:true, data:Buffer.from(content).toString("base64") };
      }
      default:
        return { ok:false, error:"不支持此操作。" };
    }
  };
}
module.exports = { createHandler };
