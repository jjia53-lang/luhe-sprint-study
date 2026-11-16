export async function loadCloudBase() {
  if (window.cloudbase) return window.cloudbase;
  // The public SDK is loaded only after a family link enables synchronization.
  const script = document.createElement("script");
  script.src = "https://static.cloudbase.net/cloudbase-js-sdk/latest/cloudbase.full.js";
  script.referrerPolicy = "no-referrer";
  try {
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(new Error("云开发组件未能加载。"));
      document.head.append(script);
    });
    if (!window.cloudbase) throw new Error("云开发组件不可用。");
    return window.cloudbase;
  } finally {
    script.remove();
  }
}
