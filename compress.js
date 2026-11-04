// Shrinks images the user picks in a page's file input (or drops on it) before the page sees them.
// Runs at document_start in every frame, so our capture listeners on window fire before any of the
// page's own handlers: we hold the event back, swap input.files for compressed copies, then replay it.
(() => {
  if (window.__samanCompress) return;
  window.__samanCompress = true;

  const DEFAULTS = { compressEnabled: true, targetKB: 300 };
  const Q_FLOOR = 0.70;          // lowest JPEG quality we accept while searching for dimensions
  const Q_MAX = 0.92;            // quality is raised up to this once the dimensions fit
  const MIN_SIDE = 480;          // never shrink the short side below this
  const MAX_SHRINK = 0.5;        // per step, never scale by less than this factor
  const ACCEPT_RATIO = 0.80;     // results under target*ratio are "too small": try bigger dimensions
  const SKIP_TYPES = /^image\/(gif|svg\+xml|heic|heif|x-icon|vnd\.microsoft\.icon)$/i;

  let cfg = { ...DEFAULTS };
  chrome.storage.sync.get(DEFAULTS).then(v => { cfg = v; }).catch(() => {});
  chrome.storage.onChanged.addListener(ch => {
    for (const k in ch) if (k in cfg) cfg[k] = ch[k].newValue;
  });

  const kb = n => n >= 1048576 ? (n / 1048576).toFixed(1).replace(".", "٫") + " مگابایت" : Math.round(n / 1024) + " کیلوبایت";
  const fa = s => String(s).replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[d]);

  // ---- status card shown while shrinking (in the frame that holds the input) ----
  // Lives in a closed shadow root so the page's CSS can't touch it, and the page can't read it.
  const FONT = "SamanVazir";
  try {
    const ff = new FontFace(FONT, `url(${chrome.runtime.getURL("fonts/Vazirmatn.woff2")})`, { weight: "100 900" });
    document.fonts.add(ff);
    ff.load().catch(() => {});
  } catch {}

  let host, ui, hideTimer;
  function card() {
    if (!host) {
      host = document.createElement("saman-compress-status");
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>
        :host { all: initial; }
        .c { position: fixed; z-index: 2147483647; top: 16px; left: 50%; transform: translate(-50%, -8px);
          width: min(360px, calc(100vw - 32px)); box-sizing: border-box; padding: 12px 14px; border-radius: 12px;
          background: #fff; color: #1f2937; border: 1px solid #e5e7eb; box-shadow: 0 10px 30px rgba(15,23,42,.18);
          font: 13px/1.8 ${FONT}, Vazirmatn, Tahoma, sans-serif; direction: rtl; text-align: right;
          opacity: 0; transition: opacity .2s, transform .2s; pointer-events: none; }
        .c.show { opacity: 1; transform: translate(-50%, 0); }
        .row { display: flex; align-items: center; gap: 10px; }
        .ico { flex: none; width: 22px; height: 22px; }
        .spin { border: 3px solid #dbeafe; border-top-color: #2563eb; border-radius: 50%; animation: r .8s linear infinite; box-sizing: border-box; }
        .ok { border-radius: 50%; background: #16a34a; color: #fff; font-size: 14px; line-height: 22px; text-align: center; }
        .t { font-weight: 700; font-size: 14px; }
        .s { color: #6b7280; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .s b { color: #15803d; }
        .bar { height: 4px; margin-top: 8px; border-radius: 2px; background: #e5e7eb; overflow: hidden; }
        .bar i { display: block; height: 100%; width: 0; background: #2563eb; transition: width .3s; margin-inline-start: 0; }
        .done .bar i { background: #16a34a; }
        @keyframes r { to { transform: rotate(360deg); } }
      </style>
      <div class="c"><div class="row"><div class="ico"></div><div style="min-width:0;flex:1">
        <div class="t"></div><div class="s"></div></div></div><div class="bar"><i></i></div></div>`;
      const q = sel => root.querySelector(sel);
      ui = { box: q(".c"), ico: q(".ico"), title: q(".t"), sub: q(".s"), bar: q(".bar i") };
    }
    if (!host.isConnected) (document.body || document.documentElement).append(host);
    clearTimeout(hideTimer);
    requestAnimationFrame(() => ui.box.classList.add("show"));
    return ui;
  }
  function hideCard(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { ui.box.classList.remove("show"); setTimeout(() => host.remove(), 250); }, ms);
  }
  function showWorking(i, n, name) {
    const u = card();
    u.box.classList.remove("done");
    u.ico.className = "ico spin"; u.ico.textContent = "";
    u.title.textContent = "در حال کم‌حجم کردن عکس...";
    u.sub.textContent = (n > 1 ? `عکس ${fa(i + 1)} از ${fa(n)}: ` : "") + name;
    u.bar.style.width = Math.round(((i + 0.5) / n) * 100) + "%";
  }
  function showDone(r) {
    if (!r.changed) { if (host) hideCard(0); return; }
    const u = card();
    u.box.classList.add("done");
    u.ico.className = "ico ok"; u.ico.textContent = "✓";
    u.title.textContent = r.changed > 1 ? `${fa(r.changed)} عکس کم‌حجم شد` : "عکس کم‌حجم شد";
    const pct = Math.round((1 - r.after / r.before) * 100);
    u.sub.replaceChildren(`${fa(kb(r.before))} ← ${fa(kb(r.after))} `);
    const b = document.createElement("b");
    b.textContent = `(${fa(pct)}٪ کمتر)`;
    u.sub.append(b);
    u.bar.style.width = "100%";
    hideCard(3500);
  }

  // ---- compression: largest size that fits at Q_FLOOR, then highest quality that still fits ----
  const isCandidate = f => f && /^image\//i.test(f.type) && !SKIP_TYPES.test(f.type) && f.size > cfg.targetKB * 1024;

  async function encode(bmp, w, h, q) {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext("2d");
    g.fillStyle = "#fff";                     // transparent PNGs would turn black in JPEG
    g.fillRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(bmp, 0, 0, w, h);
    return c.convertToBlob({ type: "image/jpeg", quality: q });
  }

  async function compress(file) {
    const target = cfg.targetKB * 1024;
    const minOk = target * ACCEPT_RATIO;
    // from-image applies the EXIF rotation, so phone photos keep their orientation once EXIF is dropped
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const W = bmp.width, H = bmp.height;
      const minScale = Math.min(1, MIN_SIDE / Math.min(W, H));
      const dims = s => [Math.max(1, Math.round(W * s)), Math.max(1, Math.round(H * s))];

      // 1) shrink (one scale for both sides, so the aspect ratio never changes) until it fits at Q_FLOOR
      let scale = 1, tooBig = null, fit = null, smallest = null;
      for (let i = 0; i < 12; i++) {
        const blob = await encode(bmp, ...dims(scale), Q_FLOOR);
        if (!smallest || blob.size < smallest.blob.size) smallest = { blob, scale };
        if (blob.size <= target) { fit = { blob, scale }; break; }
        tooBig = scale;
        if (scale <= minScale) break;
        const step = Math.max(MAX_SHRINK, Math.sqrt(target / blob.size) * 0.92);
        scale = Math.max(minScale, scale * step);
      }
      if (!fit) return smallest.blob.size < file.size ? smallest.blob : null;   // best effort

      // 2) the jump overshot (result far below target): binary-search the scale back up
      if (fit.blob.size < minOk && tooBig) {
        let lo = fit.scale, hi = tooBig;
        for (let i = 0; i < 5 && hi - lo > 0.01; i++) {
          const mid = (lo + hi) / 2;
          const blob = await encode(bmp, ...dims(mid), Q_FLOOR);
          if (blob.size <= target) { fit = { blob, scale: mid }; lo = mid; if (blob.size >= minOk) break; }
          else hi = mid;
        }
      }

      // 3) raise quality as far as the target allows at these dimensions
      let best = fit.blob, lo = Q_FLOOR, hi = Q_MAX;
      const [w, h] = dims(fit.scale);
      for (let i = 0; i < 5 && hi - lo > 0.015; i++) {
        const q = (lo + hi) / 2;
        const blob = await encode(bmp, w, h, q);
        if (blob.size <= target) { best = blob; lo = q; } else hi = q;
      }
      return best.size < file.size ? best : null;
    } finally {
      bmp.close();
    }
  }

  // returns { files: File[], changed, before, after }
  async function shrinkAll(list) {
    const files = [...list];
    let changed = 0, before = 0, after = 0;
    const out = [];
    const todo = files.filter(isCandidate);
    for (const f of files) {
      if (!isCandidate(f)) { out.push(f); continue; }
      showWorking(todo.indexOf(f), todo.length, f.name);
      try {
        const blob = await compress(f);
        if (!blob) { out.push(f); continue; }
        const name = f.name.replace(/\.[^.]*$/, "") + ".jpg";
        out.push(new File([blob], name, { type: "image/jpeg", lastModified: f.lastModified }));
        changed++; before += f.size; after += blob.size;
      } catch (e) {
        console.warn("[Saman] compress failed, keeping original:", f.name, e);
        out.push(f);
      }
    }
    return { files: out, changed, before, after };
  }

  const toList = files => { const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); return dt; };
  const needsWork = list => cfg.compressEnabled && [...(list || [])].some(isCandidate);

  // ---- file inputs: hold back input/change, swap the files, then replay both ----
  const pending = new WeakMap();   // input -> promise of the running job
  let replaying = false;

  function onPick(e) {
    const el = e.composedPath()[0];
    if (replaying || !(el instanceof HTMLInputElement) || el.type !== "file") return;
    if (!pending.has(el) && !needsWork(el.files)) return;
    e.stopImmediatePropagation();
    if (pending.has(el)) return;   // the other of input/change for the same pick
    const job = shrinkAll(el.files).then(r => {
      if (r.changed) el.files = toList(r.files).files;
      replaying = true;
      try {
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } finally { replaying = false; }
      showDone(r);
    }).finally(() => pending.delete(el));
    pending.set(el, job);
  }
  window.addEventListener("input", onPick, true);
  window.addEventListener("change", onPick, true);

  // ---- drag and drop: hold back the drop, replay it with a compressed DataTransfer ----
  function onDrop(e) {
    if (replaying || !e.dataTransfer || !needsWork(e.dataTransfer.files)) return;
    if ([...e.dataTransfer.files].length === 0) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const target = e.target, init = {
      bubbles: true, cancelable: true, composed: true,
      clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey
    };
    shrinkAll(e.dataTransfer.files).then(r => {
      replaying = true;
      try { target.dispatchEvent(new DragEvent("drop", { ...init, dataTransfer: toList(r.files) })); }
      finally { replaying = false; }
      showDone(r);
    });
  }
  window.addEventListener("drop", onDrop, true);
})();
