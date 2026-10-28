const logEl = document.getElementById("log");
const btn = document.getElementById("start");
const titleEl = document.getElementById("title");
const introEl = document.getElementById("intro");
let tabId = null, winId = null;

const log = s => {
  logEl.classList.remove("hidden");
  logEl.textContent += (logEl.textContent ? "\n" : "") + s;
  logEl.scrollTop = logEl.scrollHeight;
};
const safe = s => (s || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").slice(0, 80) || "بدون نام";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (func) => chrome.scripting.executeScript({ target: { tabId }, func }).then(r => r[0].result);
const dl = (url, filename) => chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
// Chrome's own download bubble / shelf pops up for every file and covers this popup, so hide it
// while we work and always give it back.
const downloadUi = on => chrome.downloads.setUiOptions({ enabled: on })
  .catch(e => console.warn("downloads.setUiOptions failed:", e));

// Download links (zip / dwg / pdf ...) often have no extension in the URL: ask the server for
// the real file name first so every file can be saved at an explicit folder/name path.
const EXT_BY_TYPE = { "application/pdf": ".pdf", "application/zip": ".zip", "application/x-zip-compressed": ".zip",
  "application/x-rar-compressed": ".rar", "application/vnd.rar": ".rar", "application/x-7z-compressed": ".7z",
  "image/vnd.dwg": ".dwg", "application/acad": ".dwg", "application/x-dwg": ".dwg", "image/jpeg": ".jpg", "image/png": ".png" };
async function serverName(u) {
  try {
    const r = await fetch(u, { credentials: "include" });
    r.body?.cancel();
    const cd = r.headers.get("content-disposition") || "";
    let name = "", m;
    if ((m = /filename\*\s*=\s*(?:utf-8)?'[^']*'([^;]+)/i.exec(cd))) { try { name = decodeURIComponent(m[1].trim()); } catch {} }
    if (!name && (m = /filename\s*=\s*"?([^";]+)"?/i.exec(cd))) {
      name = m[1].trim();
      try { name = decodeURIComponent(name); } catch {}
      if (/[\u00c0-\u00ff]/.test(name)) {
        try { name = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(name, c => c.charCodeAt(0))); } catch {}
      }
    }
    const ext = EXT_BY_TYPE[(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()] || "";
    return { name, ext };
  } catch { return { name: "", ext: "" }; }
}

document.getElementById("author").addEventListener("click", e => { e.preventDefault(); chrome.tabs.create({ url: e.currentTarget.href }); });

function notProject() {
  titleEl.textContent = "صفحه اطلاعات پروژه باز نیست";
  const a = document.createElement("a");
  a.href = "https://saman.fceo.ir/";
  a.textContent = "saman.fceo.ir";
  a.addEventListener("click", e => { e.preventDefault(); chrome.tabs.create({ url: a.href }); });
  introEl.replaceChildren("وارد ", a, " شوید، پروژه مورد نظر را انتخاب کنید و وارد بخش اطلاعات پروژه شوید.");
}

(async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://saman.fceo.ir/")) return notProject();
    tabId = tab.id;
    winId = tab.windowId;
    const r = await run(() => {
      const p = document.querySelector("#PersonName");
      return p ? { ok: true, owner: (p.value || "").trim() } : { ok: false };
    });
    if (!r.ok) return notProject();
    window.owner = r.owner;
    titleEl.textContent = `دانلود اسناد پروژه «${r.owner || "—"}»`;
    introEl.textContent = "فایل‌ها، اطلاعات و تصویر صفحه در پوشه Downloads ذخیره می‌شوند. تا پایان کار popup را نبندید.";
    // apply this before any download starts, or the first run still shows Chrome's bubble
    await downloadUi(false);
    await sleep(500);
    btn.classList.remove("hidden");
  } catch { notProject(); }
})();

// ---- runs inside the project page (self-contained) ----
async function collect() {
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  // any same-site http(s) resource counts as a file; in-page anchors and scripts do not
  const toUrl = raw => {
    try {
      const u = new URL(raw, location.href);
      if (!/^https?:$/.test(u.protocol) || u.hostname !== "saman.fceo.ir") return null;
      if (u.hash && u.href.split("#")[0] === location.href.split("#")[0]) return null;
      if (u.pathname === "/" || u.pathname === location.pathname) return null;
      return u.href;
    } catch {}
    return null;
  };
  const SEL = "a[href], img[src], iframe[src], embed[src], object[data], video[src], audio[src], source[src], [data-address], [data-href], [data-url], [data-src]";
  // file thumbnails: <a href=".../fileIcon.png" data-address="real file URL"> - the real file is data-address
  const urlsOf = el => el.getAttribute("data-address") ? [el.getAttribute("data-address")] : [el.getAttribute("href"), el.getAttribute("src"), el.getAttribute("data"),
    el.getAttribute("data-href"), el.getAttribute("data-url"), el.getAttribute("data-src")].filter(Boolean);
  // a file's icon (img inside its link, or a small / icon-named image) is not the file itself
  const isDecor = el => el.tagName === "IMG" && (el.closest("a[href]") || /icon|sprite|logo|blank|loading/i.test(el.getAttribute("src") || "") ||
    (el.naturalWidth > 0 && el.naturalWidth <= 64));
  const addAll = (g, root) => root.querySelectorAll(SEL).forEach(el => { if (!isDecor(el)) urlsOf(el).forEach(r => add(g, r)); });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const groups = [];
  const tabs = [];
  // dedupe per tab only: the same file may legitimately appear in more than one tab
  const group = name => { const g = { name, urls: [], seen: new Set(), skipped: 0, skippedList: [] }; groups.push(g); return g; };
  const add = (g, raw) => {
    const u = toUrl(raw);
    if (!u) { if (raw && !/^(data:|javascript:|#)/.test(raw)) { g.skipped++; g.skippedList.push(raw); } return; }
    if (!g.seen.has(u)) { g.seen.add(u); g.urls.push(u); }
  };
  let warn = "";

  const root = document.querySelector("#documentImagesTabsTrip");
  if (root) {
    const items = [...root.querySelectorAll(".k-tabstrip-items > li")];
    const getPanels = () => {
      const p = [...root.querySelectorAll(".k-tabstrip-content")];
      return p.length ? p : [...root.querySelectorAll(".k-content")];
    };
    // Kendo loads a tab's content only when it is opened, so open every tab before reading it
    const active = items.findIndex(li => li.classList.contains("k-active") || li.classList.contains("k-state-active"));
    for (let i = 0; i < items.length; i++) {
      const hasContent = () => {
        const p = getPanels()[i];
        return p && (p.querySelector(SEL) || (!p.querySelector(".k-loading, .k-i-loading") && clean(p.textContent)));
      };
      if (hasContent()) continue;
      (items[i].querySelector(".k-link") || items[i]).click();
      for (let t = 0; t < 30 && !hasContent(); t++) await sleep(100);
    }
    if (active >= 0) (items[active].querySelector(".k-link") || items[active]).click();

    const names = items.map(li => clean(li.textContent));
    const panels = getPanels();
    if (names.length && names.length === panels.length) {
      panels.forEach((p, i) => {
        const g = group(names[i]);
        addAll(g, p);
        tabs.push([g.name, g.urls.length, g.skipped, g.skippedList.slice(0, 3)]);
      });
    } else {
      warn = `ساختار تب‌ها شناسایی نشد (${names.length} تب، ${panels.length} پنل)؛ فایل‌ها در «سایر» ریخته می‌شوند.`;
      const g = group("سایر");
      addAll(g, root);
    }
  }

  const other = document.querySelector("#OtherDownload");
  if (other?.href) add(group("فایل پیوست"), other.href);

  const info = [];
  document.querySelectorAll(".form-group").forEach(g => {
    if (!g.offsetParent) return;
    const label = clean(g.querySelector("label")?.textContent);
    if (!label) return;
    let v = "";
    const ta = g.querySelector("textarea");
    if (ta) v = ta.value;
    else if (g.querySelector(".k-dropdownlist")) v = clean(g.querySelector(".k-input-value-text")?.textContent);
    else {
      const inp = [...g.querySelectorAll("input")].find(i => i.offsetParent !== null);
      v = inp ? (inp.value || inp.title || "") : "";
    }
    if (v === "انتخاب کنید") v = "";
    info.push([label, v.trim()]);
  });

  return { groups: groups.filter(g => g.urls.length).map(g => ({ name: g.name, urls: g.urls })), tabs, info, warn };
}

// Screenshot without the "debugger" permission: scroll through the fields area, grab the visible
// tab at each step (captureVisibleTab) and stitch the slices together on a canvas.

// hide fixed/sticky bars, scroll the fields into view, return the area to capture (page coordinates)
function prepShot() {
  let groups = [...document.querySelectorAll(".form-group")].filter(g => g.offsetParent && g.querySelector("label"));
  const i = groups.findIndex(g => g.querySelector("#FinalArea"));
  if (i > 0) groups = groups.slice(i);
  if (!groups.length) return null;

  window.__hidden = [];
  window.__scroll = [scrollX, scrollY, document.documentElement.style.scrollBehavior];
  document.documentElement.style.scrollBehavior = "auto";
  document.querySelectorAll("body *").forEach(el => {
    const p = getComputedStyle(el).position;
    if (p === "fixed" || p === "sticky") { window.__hidden.push([el, el.style.visibility]); el.style.visibility = "hidden"; }
  });

  let L = 1e9, T = 1e9, R = 0, B = 0;
  groups.forEach(g => {
    const r = g.getBoundingClientRect();
    L = Math.min(L, r.left + scrollX); T = Math.min(T, r.top + scrollY);
    R = Math.max(R, r.right + scrollX); B = Math.max(B, r.bottom + scrollY);
  });
  const pad = 10;
  L = Math.max(0, L - pad); T = Math.max(0, T - pad); R += pad; B += pad;
  return { x: L, y: T, w: R - L, h: B - T, vw: innerWidth, vh: innerHeight };
}
function restoreShot() {
  (window.__hidden || []).forEach(([el, v]) => { el.style.visibility = v; });
  window.__hidden = [];
  if (window.__scroll) {
    document.documentElement.style.scrollBehavior = window.__scroll[2];
    scrollTo(window.__scroll[0], window.__scroll[1]);
    window.__scroll = null;
  }
}

async function screenshot() {
  const r = await run(prepShot);
  if (!r) throw new Error("ناحیه فیلدها پیدا نشد");
  try {
    const step = r.vh;
    let canvas = null, ctx = null, scale = 1;
    for (let top = r.y; top < r.y + r.h; top += step) {
      // scroll, then read back the real scroll offset (the last step is clamped by the page end)
      const sy = await chrome.scripting.executeScript({
        target: { tabId }, args: [top],
        func: y => { window.scrollTo(window.scrollX, y); return [window.scrollX, window.scrollY]; }
      }).then(x => x[0].result);
      await sleep(650); // captureVisibleTab is limited to 2 calls per second
      const img = await createImageBitmap(await (await fetch(
        await chrome.tabs.captureVisibleTab(winId, { format: "png" }))).blob());
      scale = img.width / r.vw;
      if (!canvas) {
        canvas = new OffscreenCanvas(Math.round(Math.min(r.w, r.vw - r.x + sy[0]) * scale), Math.round(r.h * scale));
        ctx = canvas.getContext("2d");
      }
      const from = Math.max(r.y, sy[1]), to = Math.min(r.y + r.h, sy[1] + r.vh);
      if (to <= from) continue;
      ctx.drawImage(img,
        (r.x - sy[0]) * scale, (from - sy[1]) * scale, canvas.width, (to - from) * scale,
        0, (from - r.y) * scale, canvas.width, (to - from) * scale);
    }
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    await run(restoreShot).catch(() => {});
  }
}

// never let one slow step freeze the whole run
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: پاسخی نیامد`)), ms))]);
const fa = n => Number(n).toLocaleString("fa-IR");
const dirOf = f => f.replace(/[\\/][^\\/]*$/, "");
const progressEl = document.getElementById("progress");
const summaryEl = document.getElementById("summary");

// poll until every started download has finished (or failed); returns the final items
async function waitDownloads(jobs, onTick) {
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    const items = await Promise.all(jobs.map(j => chrome.downloads.search({ id: j.id }).then(r => r[0])));
    const done = items.filter(it => it && it.state !== "in_progress").length;
    onTick(done, jobs.length);
    if (done === jobs.length || Date.now() > deadline) return items;
    await sleep(500);
  }
}

function showSummary({ owner, groups, jobs, items, failed, dir, showId }) {
  const okN = items.filter(it => it?.state === "complete").length;
  const errs = failed.concat(jobs.flatMap((j, i) => items[i]?.state === "interrupted" ? [{ name: j.name, msg: items[i].error }] : []));
  const total = jobs.filter(j => j.kind === "file").length;
  const filesOk = items.filter((it, i) => jobs[i].kind === "file" && it?.state === "complete").length;
  summaryEl.replaceChildren();
  const row = (cls, text) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; summaryEl.append(d); return d; };
  row(errs.length ? "warn" : "ok", errs.length
    ? `${fa(filesOk)} فایل از ${fa(total)} فایل دانلود شد؛ ${fa(errs.length)} مورد ناموفق بود.`
    : `همه ${fa(total)} فایل در ${fa(groups)} پوشه دانلود شد.`);
  row("meta", "همراه با فایل اطلاعات پروژه و تصویر صفحه.");
  errs.forEach(e => row("err", `✗ ${e.name}${e.msg ? " — " + e.msg : ""}`));
  if (dir && showId != null) {
    const a = document.createElement("a");
    a.href = "#";
    a.dir = "ltr";
    a.className = "path";
    a.textContent = dir;
    a.title = "باز کردن پوشه";
    a.addEventListener("click", e => { e.preventDefault(); chrome.downloads.show(showId); setTimeout(() => window.close(), 200); });
    row("meta", "محل ذخیره (با کلیک باز می‌شود):");
    summaryEl.append(a);
  }
  summaryEl.classList.remove("hidden");
}

addEventListener("pagehide", () => downloadUi(true));

btn.addEventListener("click", async () => {
  btn.disabled = true;
  await downloadUi(false);
  await sleep(300);
  summaryEl.classList.add("hidden");
  const jobs = [];      // { id, name, kind }
  const failed = [];    // downloads that could not even start
  try {
    const base = `Saman/${safe(window.owner)}`;
    const data = await run(collect);
    if (data.warn) log("⚠ " + data.warn);
    data.tabs.filter(([, n]) => !n).forEach(([name]) => log(`○ تب «${name}» فایلی نداشت`));

    // project info
    const text = data.info.map(([k, v]) => `${k}: ${v}`).join("\r\n");
    const infoUrl = URL.createObjectURL(new Blob(["\uFEFF" + text], { type: "text/plain;charset=utf-8" }));
    const infoId = await dl(infoUrl, `${base}/اطلاعات پروژه.txt`);
    jobs.push({ id: infoId, name: "اطلاعات پروژه", kind: "info" });
    log(`✓ اطلاعات پروژه (${fa(data.info.length)} فیلد)`);

    // screenshot
    try {
      const url = URL.createObjectURL(await screenshot());
      jobs.push({ id: await dl(url, `${base}/تصویر اطلاعات پروژه.png`), name: "اسکرین‌شات", kind: "shot" });
      log("✓ تصویر صفحه اطلاعات");
    } catch (e) { failed.push({ name: "اسکرین‌شات", msg: e.message }); log("✗ اسکرین‌شات: " + e.message); }

    // files
    const totalFiles = data.groups.reduce((n, g) => n + g.urls.length, 0);
    let started = 0;
    progressEl.classList.remove("hidden");
    for (const g of data.groups) {
      log(`📁 ${g.name}: ${fa(g.urls.length)} فایل`);
      for (const u of g.urls) {
        progressEl.textContent = `در حال شروع دانلود… ${fa(++started)} از ${fa(totalFiles)}`;
        let name = new URL(u).pathname.split("/").pop() || "file";
        try { name = decodeURIComponent(name); } catch {}
        try {
          if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
            const sv = await withTimeout(serverName(u), 20000, "دریافت نام فایل");
            name = sv.name || (name + sv.ext);
          }
          jobs.push({ id: await withTimeout(dl(u, `${base}/${safe(g.name)}/${safe(name)}`), 30000, "شروع دانلود"), name, kind: "file" });
        } catch (e) { failed.push({ name, msg: e.message }); log(`  ✗ ${name}: ${e.message}`); }
        await sleep(150);
      }
    }

    const nFiles = jobs.filter(j => j.kind === "file").length + failed.filter(f => f.name !== "اسکرین‌شات").length;
    if (!nFiles) log("هیچ فایلی برای دانلود پیدا نشد.");

    const items = await waitDownloads(jobs, (d, t) => { progressEl.textContent = `در حال دانلود… ${fa(d)} از ${fa(t)}`; });
    progressEl.classList.add("hidden");

    const info = items[0];
    showSummary({ owner: window.owner, groups: data.groups.length, jobs, items, failed,
      dir: info?.filename ? dirOf(info.filename) : "", showId: info?.state === "complete" ? infoId : null });
  } catch (e) {
    progressEl.classList.add("hidden");
    log("خطا: " + (e.message || e));
  } finally {
    await downloadUi(true);
    btn.disabled = false;
  }
});
