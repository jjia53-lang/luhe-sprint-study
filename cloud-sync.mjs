const firstDay = "2026-11-16";
const subjects = ["数学","英语","其他"];
const noteLimit = 1000;

export function completionEvent(kind, item) {
  if (kind === "vocab") {
    const notes = typeof item.notes === "string" ? item.notes.trim().slice(0, 500) : "";
    return { kind, itemId:"words", date:item.date, minutes:item.minutes, revision:item.completedAt, ...(notes ? {notes} : {}) };
  }
  const notes = typeof item.notes === "string" ? item.notes.trim().slice(0, noteLimit) : "";
  return {
    kind, itemId:item.id, date:item.date, title:item.title, subject:item.subject,
    minutes:item.actualMinutes, revision:item.submittedAt, ...(notes ? {notes} : {}),
  };
}

// Mirrors the cloud function's checks so one bad local record can never block the upload queue.
export function uploadable(entry) {
  if (!entry || typeof entry.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || entry.date < firstDay) return false;
  if (!Number.isInteger(entry.minutes) || entry.minutes < 1 || entry.minutes > 600) return false;
  if (typeof entry.revision !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.revision)) return false;
  if (entry.kind === "vocab") return true;
  return entry.kind === "task" && typeof entry.itemId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(entry.itemId)
    && typeof entry.title === "string" && !!entry.title.trim() && entry.title.length <= 140 && subjects.includes(entry.subject);
}

export function enqueueCompletion(state, entry) {
  if (!uploadable(entry)) return;
  const pending = state.syncPending ??= [];
  const index = pending.findIndex(row => row.kind === entry.kind && row.itemId === entry.itemId && row.date === entry.date);
  if (index < 0) pending.push(entry);
  else if (pending[index].revision <= entry.revision) pending[index] = entry;
}

const cloudKey = entry => entry.kind === "vocab" ? "vocab:" + entry.date : "task:" + entry.itemId;

// Applies newer cloud completions to this browser and queues local completions the cloud has not seen.
// It only adds or updates completions, so local notes, attachments and other records stay untouched.
export function mergeCloud(state, entries) {
  const cloud = new Map();
  for (const entry of entries) {
    const key = cloudKey(entry);
    if (!cloud.has(key) || cloud.get(key).revision <= entry.revision) cloud.set(key, entry);
  }
  let changed = 0;
  state.tasks ??= [];
  state.vocabulary ??= [];
  for (const entry of cloud.values()) {
    if (entry.kind === "task") {
      let task = state.tasks.find(item => item.id === entry.itemId);
      if (!task) {
        task = {id:entry.itemId, date:entry.date, subject:entry.subject, title:entry.title, minutes:entry.minutes, status:"planned"};
        state.tasks.push(task);
      }
      if (task.status !== "submitted" || (task.submittedAt ?? "") < entry.revision) {
        Object.assign(task, {status:"submitted", actualMinutes:entry.minutes, submittedAt:entry.revision,
          notes:entry.notes ?? ""});
        changed++;
      }
    } else if (entry.kind === "vocab") {
      const index = state.vocabulary.findIndex(item => item.date === entry.date);
      const notes = entry.notes ?? "";
      if (index < 0) { state.vocabulary.unshift({date:entry.date, minutes:entry.minutes, completedAt:entry.revision, notes}); changed++; }
      else if ((state.vocabulary[index].completedAt ?? "") < entry.revision) {
        state.vocabulary[index] = {...state.vocabulary[index], minutes:entry.minutes, completedAt:entry.revision, notes};
        changed++;
      }
    }
  }
  const local = [
    ...state.tasks.filter(task => task.status === "submitted").map(task => completionEvent("task", task)),
    ...state.vocabulary.map(item => completionEvent("vocab", item)),
  ];
  for (const entry of local) {
    const seen = cloud.get(cloudKey(entry));
    if (!seen || seen.revision < entry.revision || (seen.revision === entry.revision && (seen.notes ?? "") !== (entry.notes ?? ""))) {
      enqueueCompletion(state, entry);
    }
  }
  if (state.syncPending) state.syncPending = state.syncPending.filter(uploadable);
  return changed;
}

// ---- Study records: logs, mistakes, words, edited tasks, exam settings and attachment details ----
// Each record carries its own revision (updatedAt). Deletions leave a tombstone in state.removed,
// so a record deleted on one device is also removed on the others instead of coming back.
export const baseRevision = "2026-11-16T00:00:00.000Z";
export const chunkSize = 600000;
const planFields = ["date","subject","title","minutes","detail"];
const settingFields = ["examDate","monthlyDate","examConfirmed"];
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const without = (value, fields) => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
const stamp = () => new Date().toISOString();
export const recordKey = (type, id) => type + ":" + id;
export const chunkCount = size => Math.max(1, Math.ceil(size / chunkSize));

export function touch(row) { row.updatedAt = stamp(); return row; }
export function forget(state, type, id) { (state.removed ??= {})[recordKey(type, id)] = stamp(); }
export function revive(state, type, id) { if (state.removed) delete state.removed[recordKey(type, id)]; }

export function localRecords(state) {
  const rows = new Map();
  const add = (type, id, rev, data, extra = {}) => rows.set(recordKey(type, id), {type, id, rev:rev ?? baseRevision, deleted:false, data, ...extra});
  for (const log of state.logs ?? []) add("log", log.id, log.updatedAt, without(log, ["id","updatedAt"]));
  for (const item of state.mistakes ?? []) add("mistake", item.id, item.updatedAt, without(item, ["id","updatedAt"]));
  for (const word of state.words ?? []) add("word", word.key, word.updatedAt, without(word, ["updatedAt"]));
  for (const task of state.tasks ?? []) if (task.updatedAt) add("task", task.id, task.updatedAt, pick(task, planFields));
  if (state.settingsUpdatedAt) add("settings", "exam", state.settingsUpdatedAt, pick(state, settingFields));
  for (const review of state.reviews ?? []) add("review", review.id, review.updatedAt ?? review.createdAt, without(review, ["id"]));
  for (const file of state.attachments ?? []) {
    add("attachment", file.id, file.updatedAt, pick(file, ["taskId","name","size","type"]), {needsUpload:!file.uploaded && !file.remote});
  }
  for (const [key, rev] of Object.entries(state.removed ?? {})) {
    const at = key.indexOf(":");
    const live = rows.get(key);
    if (!live || live.rev < rev) rows.set(key, {type:key.slice(0, at), id:key.slice(at + 1), rev, deleted:true, data:null});
  }
  return rows;
}

function applyRecord(state, row) {
  const key = recordKey(row.type, row.id);
  const list = {log:"logs", mistake:"mistakes", word:"words", attachment:"attachments", review:"reviews"}[row.type];
  const idField = row.type === "word" ? "key" : "id";
  if (row.deleted) {
    (state.removed ??= {})[key] = row.rev;
    if (list) state[list] = (state[list] ?? []).filter(item => item[idField] !== row.id);
    if (row.type === "task") state.tasks = (state.tasks ?? []).filter(task => task.id !== row.id || task.status === "submitted");
    return;
  }
  if (state.removed) delete state.removed[key];
  if (row.type === "settings") { Object.assign(state, pick(row.data, settingFields)); state.settingsUpdatedAt = row.rev; return; }
  if (row.type === "task") {
    const task = (state.tasks ??= []).find(item => item.id === row.id);
    if (task) Object.assign(task, pick(row.data, planFields), {updatedAt:row.rev});
    else state.tasks.push({...pick(row.data, planFields), id:row.id, status:"planned", updatedAt:row.rev});
    return;
  }
  const rows = state[list] ??= [];
  const index = rows.findIndex(item => item[idField] === row.id);
  const next = {...row.data, [idField]:row.id, updatedAt:row.rev};
  if (row.type === "attachment") {
    const local = rows[index];
    Object.assign(next, {uploaded:true, remote:!local || local.remote === true});
  }
  if (index < 0) rows.push(next); else rows[index] = next;
}

// Applies newer cloud records and returns the local ones the cloud is missing or has older copies of.
export function mergeRecords(state, cloudRows) {
  const cloud = new Map();
  for (const row of cloudRows) {
    const key = recordKey(row.type, row.id);
    if (!cloud.has(key) || cloud.get(key).rev <= row.rev) cloud.set(key, row);
  }
  const local = localRecords(state);
  let changed = 0;
  for (const [key, row] of cloud) {
    const mine = local.get(key);
    if (!mine || mine.rev < row.rev) { applyRecord(state, row); changed++; }
  }
  const push = [], uploads = [];
  for (const [key, row] of localRecords(state)) {
    const seen = cloud.get(key);
    if (seen && seen.rev >= row.rev) continue;
    // A student device uploads only feedback written in its own parent preview; parent-link feedback already lives in the cloud.
    if ((row.type === "review" && row.data?.author !== "家长（本机）") || !validRecord(row)) continue;
    if (row.needsUpload) { uploads.push(row.id); continue; }
    push.push({type:row.type, id:row.id, rev:row.rev, deleted:row.deleted, data:row.data});
  }
  return {changed, push, uploads};
}

// Mirrors the cloud function's record checks so a single oversized record stays local instead of blocking the rest.
export function validRecord(row) {
  const idOk = row.type === "word" ? typeof row.id === "string" && row.id.length >= 1 && row.id.length <= 200
    : row.type === "settings" ? row.id === "exam" : typeof row.id === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(row.id);
  if (!idOk || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.rev)) return false;
  if (row.deleted) return true;
  if (!row.data || JSON.stringify(row.data).length > 20000) return false;
  if (row.type !== "attachment") return true;
  const {taskId, name, size, type} = row.data;
  return /^[a-zA-Z0-9-]{1,100}$/.test(taskId ?? "") && typeof name === "string" && !!name && name.length <= 200
    && Number.isInteger(size) && size >= 1 && size <= 8 * 1024 * 1024 && typeof type === "string" && type.length <= 100;
}

export function recordBatches(rows, limit = 100000) {
  const batches = [];
  let batch = [], size = 0;
  for (const row of rows) {
    const length = JSON.stringify(row).length;
    if (batch.length && (batch.length >= 10 || size + length > limit)) { batches.push(batch); batch = []; size = 0; }
    batch.push(row); size += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function linkToken(location, history, storage, legacy) {
  const key = "sprint-sync-token";
  const incoming = new URLSearchParams(location.hash.slice(1)).get("sync");
  if (incoming !== null) {
    history.replaceState(history.state, "", location.pathname + location.search);
    storage.removeItem(key);
    legacy?.removeItem(key);
    if (/^[0-9a-f]{64}$/.test(incoming)) storage.setItem(key, incoming);
  } else if (!storage.getItem(key) && legacy?.getItem(key)) {
    storage.setItem(key, legacy.getItem(key));
    legacy.removeItem(key);
  }
  return storage.getItem(key);
}

export function createSync(request, token, withState) {
  let running;
  async function call(action, input = {}) {
    const reply = await request({ action, token, ...input });
    if (!reply?.ok) throw new Error(reply?.error || "无法连接云端。");
    return reply;
  }
  async function upload() {
    while (true) {
      const state = await withState();
      const pending = (state.syncPending ?? []).slice(0, 20);
      if (!pending.length) return;
      const result = await call("save", {entries:pending});
      if (result.count !== pending.length) throw new Error("云端确认不完整。");
      await withState(current => {
        const sent = new Set(pending.map(row => JSON.stringify(row)));
        current.syncPending = (current.syncPending ?? []).filter(row => !sent.has(JSON.stringify(row)));
      });
    }
  }
  return {
    connect:() => call("connect"),
    day:date => call("day", {date}),
    all:() => call("all"),
    records:() => call("records"),
    saveRecords:records => call("records.save", {records}),
    putChunk:(file, index, total, data) => call("file.put", {file, index, total, data}),
    getChunk:(file, index) => call("file.get", {file, index}),
    flush() {
      if (!running) running = upload().finally(() => { running = undefined; });
      return running;
    },
  };
}
