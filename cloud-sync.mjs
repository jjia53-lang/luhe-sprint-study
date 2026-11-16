const firstDay = "2026-11-16";
const subjects = ["数学","英语","其他"];
const noteLimit = 1000;

export function completionEvent(kind, item) {
  if (kind === "vocab") {
    return { kind, itemId:"words", date:item.date, minutes:item.minutes, revision:item.completedAt };
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
      if (index < 0) { state.vocabulary.unshift({date:entry.date, minutes:entry.minutes, completedAt:entry.revision}); changed++; }
      else if ((state.vocabulary[index].completedAt ?? "") < entry.revision) {
        state.vocabulary[index] = {...state.vocabulary[index], minutes:entry.minutes, completedAt:entry.revision};
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
    flush() {
      if (!running) running = upload().finally(() => { running = undefined; });
      return running;
    },
  };
}
