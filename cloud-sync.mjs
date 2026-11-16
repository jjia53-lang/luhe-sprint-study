export function completionEvent(kind, item) {
  if (kind === "vocab") {
    return { kind, itemId:"words", date:item.date, minutes:item.minutes, revision:item.completedAt };
  }
  return {
    kind, itemId:item.id, date:item.date, title:item.title, subject:item.subject,
    minutes:item.actualMinutes, revision:item.submittedAt,
  };
}

export function enqueueCompletion(state, entry) {
  const pending = state.syncPending ??= [];
  const index = pending.findIndex(row => row.kind === entry.kind && row.itemId === entry.itemId && row.date === entry.date);
  if (index < 0) pending.push(entry);
  else if (pending[index].revision <= entry.revision) pending[index] = entry;
}

export function linkToken(location, history, storage) {
  const incoming = new URLSearchParams(location.hash.slice(1)).get("sync");
  if (incoming !== null) {
    history.replaceState(history.state, "", location.pathname + location.search);
    storage.removeItem("sprint-sync-token");
    if (/^[0-9a-f]{64}$/.test(incoming)) storage.setItem("sprint-sync-token", incoming);
  }
  return storage.getItem("sprint-sync-token");
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
    flush() {
      if (!running) running = upload().finally(() => { running = undefined; });
      return running;
    },
  };
}
