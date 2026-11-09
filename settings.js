// Image compression settings (read by compress.js through chrome.storage.sync)
(async () => {
  const DEFAULTS = { compressEnabled: true, targetKB: 300 };
  const on = document.getElementById("compressOn");
  const kb = document.getElementById("targetKB");
  const row = kb.closest("label");
  const v = await chrome.storage.sync.get(DEFAULTS);
  on.checked = v.compressEnabled;
  kb.value = v.targetKB;
  row.classList.toggle("off", !on.checked);
  on.addEventListener("change", () => {
    row.classList.toggle("off", !on.checked);
    chrome.storage.sync.set({ compressEnabled: on.checked });
  });
  kb.addEventListener("change", () => {
    const n = Math.min(5000, Math.max(50, Math.round(+kb.value) || DEFAULTS.targetKB));
    kb.value = n;
    chrome.storage.sync.set({ targetKB: n });
  });

  // Feedback: opens the user's mail app with the version and browser already filled in.
  // Nothing is sent by the extension itself; the user reads and sends the mail.
  const m = chrome.runtime.getManifest();
  const ua = navigator.userAgent.match(/(Edg|Chrome)\/[\d.]+/);
  const subject = encodeURIComponent(`بازخورد افزونه ${m.name} (نسخه ${m.version})`);
  const body = encodeURIComponent(`\n\n---\nنسخه افزونه: ${m.version}\nمرورگر: ${ua ? ua[0] : navigator.userAgent}`);
  document.getElementById("feedback").href = `mailto:jamalkhah@gmail.com?subject=${subject}&body=${body}`;
})();
