// Cap Digital — tempel stempel PNG ke PDF, sepenuhnya di browser.
// PDF dirender dengan pdf.js, dan file hasil akhirnya dirakit dengan pdf-lib.
// Tidak ada file yang pernah dikirim ke server manapun.

const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.1.200/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.1.200/pdf.worker.min.mjs";
const MANIFEST_URL = "assets/stamps/manifest.json";

let pdfjsLib = null;
let pdfDoc = null;
let originalBytes = null;
let sourceFileName = "dokumen";

let currentPage = 1;
let numPages = 0;
let currentScale = 1;
let currentRenderTask = null;
let rotationWarned = false;

const pageDims = new Map();      // pageNum -> { w, h, rotate } in PDF points, scale 1
const imageNaturalSize = new Map(); // src -> { w, h }
let stamps = [];                 // { id, page, src, xPt, yPt, wPt, hPt }
let stampSeq = 1;
let activeStampId = null;
let toastTimer = null;

const els = {};

document.addEventListener("DOMContentLoaded", init);

function cacheEls() {
  els.fileInput = document.getElementById("file-input");
  els.customInput = document.getElementById("custom-stamp-input");
  els.downloadBtn = document.getElementById("download-btn");
  els.prevBtn = document.getElementById("prev-page");
  els.nextBtn = document.getElementById("next-page");
  els.pageNav = document.getElementById("page-nav");
  els.pageCurrent = document.getElementById("page-current");
  els.pageTotal = document.getElementById("page-total");
  els.stampGrid = document.getElementById("stamp-grid");
  els.workspace = document.getElementById("workspace");
  els.emptyState = document.getElementById("empty-state");
  els.pageStage = document.getElementById("page-stage");
  els.pageSheet = document.getElementById("page-sheet");
  els.canvas = document.getElementById("pdf-canvas");
  els.overlay = document.getElementById("overlay");
  els.toast = document.getElementById("toast");
}

async function init() {
  cacheEls();
  wireEvents();
  loadManifest();

  try {
    pdfjsLib = await import(PDFJS_URL);
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  } catch (err) {
    console.error(err);
    showToast("Gagal memuat mesin pembaca PDF. Periksa koneksi internet.");
  }
}

function wireEvents() {
  els.fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleFileUpload(file);
    e.target.value = "";
  });

  els.customInput.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      const url = URL.createObjectURL(file);
      const label = file.name.replace(/\.png$/i, "");
      addStampThumb(url, label);
    }
    e.target.value = "";
  });

  els.prevBtn.addEventListener("click", () => {
    if (currentPage > 1) renderPage(currentPage - 1);
  });
  els.nextBtn.addEventListener("click", () => {
    if (currentPage < numPages) renderPage(currentPage + 1);
  });

  els.downloadBtn.addEventListener("click", downloadStampedPdf);

  els.overlay.addEventListener("pointerdown", (e) => {
    if (e.target === els.overlay) setActiveStamp(null);
  });

  window.addEventListener("resize", debounce(() => {
    if (pdfDoc) renderPage(currentPage);
  }, 220));

  window.addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && activeStampId !== null) {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      removeStamp(activeStampId);
    }
  });
}

/* ---------------- Sidebar: stamp palette ---------------- */

async function loadManifest() {
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error("manifest not found");
    const list = await res.json();
    for (const item of list) {
      addStampThumb(`assets/stamps/${item.file}`, item.label || item.file);
    }
  } catch (err) {
    console.warn("Tidak bisa memuat manifest.json:", err);
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "Belum ada stempel terdaftar. Tambahkan file PNG di assets/stamps/ dan daftarkan pada manifest.json.";
    els.stampGrid.parentNode.insertBefore(note, els.stampGrid);
  }
}

function addStampThumb(src, label) {
  const thumb = document.createElement("div");
  thumb.className = "stamp-thumb";
  thumb.innerHTML = `<img src="${src}" alt="${escapeHtml(label)}" /><span>${escapeHtml(label)}</span>`;
  wireThumbDrag(thumb, src);
  els.stampGrid.appendChild(thumb);
}

// Custom pointer-based long-press drag: works with mouse, touch (iPad/iPhone)
// and pen alike, since the native HTML5 Drag-and-Drop API does not work on
// iOS Safari touch. A quick tap places the stamp centered on the page; a
// press-and-hold followed by a drag places it exactly where it's released.
// A plain swipe (used to scroll the stamp tray) is left alone.
const LONG_PRESS_MS = 220;
const MOVE_CANCEL_PX = 10;

function wireThumbDrag(thumb, src) {
  thumb.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let armed = false;
    let ghost = null;
    const timer = setTimeout(() => {
      armed = true;
      thumb.classList.add("dragging");
    }, LONG_PRESS_MS);

    function updateGhost(x, y) {
      if (!ghost) {
        ghost = document.createElement("div");
        ghost.className = "ghost-drag";
        ghost.innerHTML = `<img src="${src}" alt="" />`;
        document.body.appendChild(ghost);
      }
      ghost.style.left = x + "px";
      ghost.style.top = y + "px";
      els.pageSheet.classList.toggle("drop-active", pdfDoc ? isOverOverlay(x, y) : false);
    }

    function detach() {
      clearTimeout(timer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    }

    function cleanup() {
      detach();
      if (ghost) ghost.remove();
      thumb.classList.remove("dragging");
      els.pageSheet.classList.remove("drop-active");
    }

    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!armed) {
        if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) {
          // Looks like a scroll/pan, not a drag attempt — back off and
          // let the browser handle the gesture normally.
          detach();
          thumb.classList.remove("dragging");
        }
        return;
      }
      ev.preventDefault();
      updateGhost(ev.clientX, ev.clientY);
    }

    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      const wasArmed = armed;
      const hadGhost = !!ghost;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const tappedInPlace = Math.hypot(dx, dy) <= MOVE_CANCEL_PX;
      cleanup();

      if (wasArmed) {
        if (hadGhost && pdfDoc && isOverOverlay(ev.clientX, ev.clientY)) {
          const rect = els.overlay.getBoundingClientRect();
          dropStampAt(src, ev.clientX - rect.left, ev.clientY - rect.top);
        }
      } else if (tappedInPlace) {
        addStampCentered(src);
      }
    }

    function onCancel(ev) {
      if (ev.pointerId !== pointerId) return;
      cleanup();
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  });
}

function isOverOverlay(clientX, clientY) {
  const rect = els.overlay.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

/* ---------------- PDF loading & rendering ---------------- */

async function handleFileUpload(file) {
  if (!pdfjsLib) {
    showToast("Mesin PDF belum siap, coba sebentar lagi.");
    return;
  }
  sourceFileName = file.name.replace(/\.pdf$/i, "") || "dokumen";

  const buf = await file.arrayBuffer();
  originalBytes = new Uint8Array(buf);

  stamps = [];
  activeStampId = null;
  pageDims.clear();
  rotationWarned = false;

  try {
    const loadingTask = pdfjsLib.getDocument({ data: originalBytes.slice() });
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    console.error(err);
    showToast("Gagal membuka PDF. Pastikan filenya valid.");
    return;
  }

  numPages = pdfDoc.numPages;
  els.pageTotal.textContent = numPages;
  els.emptyState.hidden = true;
  els.pageStage.hidden = false;
  els.pageNav.hidden = false;
  els.downloadBtn.disabled = false;

  await renderPage(1);
}

async function getPageDims(pageNum) {
  if (pageDims.has(pageNum)) return pageDims.get(pageNum);
  const page = await pdfDoc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const info = { w: vp.width, h: vp.height, rotate: page.rotate };
  pageDims.set(pageNum, info);
  return info;
}

async function renderPage(pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const dims = await getPageDims(pageNum);

  if (dims.rotate !== 0 && !rotationWarned) {
    rotationWarned = true;
    showToast("Halaman ini memakai rotasi bawaan PDF — posisi stempel pada hasil unduhan bisa sedikit meleset.", 4600);
  }

  const available = Math.max(els.workspace.clientWidth - 64, 240);
  const containerW = Math.min(available, 880);
  const scale = Math.max(containerW / dims.w, 0.15);
  currentScale = scale;

  const viewport = page.getViewport({ scale });
  const outputScale = window.devicePixelRatio || 1;

  const canvas = els.canvas;
  const ctx = canvas.getContext("2d");
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = Math.floor(viewport.width) + "px";
  canvas.style.height = Math.floor(viewport.height) + "px";
  els.pageSheet.style.width = Math.floor(viewport.width) + "px";
  els.pageSheet.style.height = Math.floor(viewport.height) + "px";

  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;

  if (currentRenderTask) {
    try { currentRenderTask.cancel(); } catch (_) { /* ignore */ }
  }
  currentRenderTask = page.render({ canvasContext: ctx, transform, viewport });
  try {
    await currentRenderTask.promise;
  } catch (err) {
    if (err && err.name === "RenderingCancelledException") return;
    console.error(err);
  }

  currentPage = pageNum;
  els.pageCurrent.textContent = pageNum;
  els.prevBtn.disabled = pageNum <= 1;
  els.nextBtn.disabled = pageNum >= numPages;

  renderStampsForCurrentPage();
}

/* ---------------- Placing stamps ---------------- */

function getImageNaturalSize(src) {
  if (imageNaturalSize.has(src)) return Promise.resolve(imageNaturalSize.get(src));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const size = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 };
      imageNaturalSize.set(src, size);
      resolve(size);
    };
    img.onerror = () => resolve({ w: 1, h: 1 });
    img.src = src;
  });
}

async function addStampCentered(src) {
  if (!pdfDoc) {
    showToast("Unggah PDF terlebih dahulu.");
    return;
  }
  const dims = await getPageDims(currentPage);
  const natural = await getImageNaturalSize(src);
  const wPt = Math.min(dims.w * 0.28, 130);
  const hPt = wPt * (natural.h / natural.w);
  const xPt = (dims.w - wPt) / 2;
  const yPt = (dims.h - hPt) / 2;
  addStamp(src, xPt, yPt, wPt, hPt);
}

async function dropStampAt(src, pxX, pxY) {
  const dims = await getPageDims(currentPage);
  const natural = await getImageNaturalSize(src);

  const wPt = Math.min(dims.w * 0.28, 130);
  const hPt = wPt * (natural.h / natural.w);
  const xPt = pxX / currentScale - wPt / 2;
  const yPt = pxY / currentScale - hPt / 2;

  addStamp(src, xPt, yPt, wPt, hPt);
}

function addStamp(src, xPt, yPt, wPt, hPt) {
  const stamp = {
    id: stampSeq++,
    page: currentPage,
    src,
    xPt: Math.max(0, xPt),
    yPt: Math.max(0, yPt),
    wPt,
    hPt,
  };
  stamps.push(stamp);
  renderStampsForCurrentPage();
  setActiveStamp(stamp.id);
}

function removeStamp(id) {
  stamps = stamps.filter((s) => s.id !== id);
  activeStampId = null;
  renderStampsForCurrentPage();
}

function setActiveStamp(id) {
  activeStampId = id;
  els.overlay.querySelectorAll(".stamp-instance").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.id) === id);
  });
}

/* ---------------- Overlay rendering & drag/resize ---------------- */

function renderStampsForCurrentPage() {
  els.overlay.innerHTML = "";
  const onPage = stamps.filter((s) => s.page === currentPage);
  for (const stamp of onPage) {
    els.overlay.appendChild(buildStampEl(stamp));
  }
}

function buildStampEl(stamp) {
  const el = document.createElement("div");
  el.className = "stamp-instance";
  el.dataset.id = String(stamp.id);
  applyStampGeometry(el, stamp);

  const img = document.createElement("img");
  img.src = stamp.src;
  img.alt = "";
  img.draggable = false;
  el.appendChild(img);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "stamp-remove";
  removeBtn.setAttribute("aria-label", "Hapus stempel");
  removeBtn.textContent = "\u00D7";
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    removeStamp(stamp.id);
  });
  el.appendChild(removeBtn);

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "stamp-resize";
  resizeHandle.addEventListener("pointerdown", (e) => startResize(e, el, stamp));
  el.appendChild(resizeHandle);

  el.addEventListener("pointerdown", (e) => {
    if (e.target === removeBtn || e.target === resizeHandle) return;
    startMove(e, el, stamp);
  });

  return el;
}

function applyStampGeometry(el, stamp) {
  el.style.left = stamp.xPt * currentScale + "px";
  el.style.top = stamp.yPt * currentScale + "px";
  el.style.width = stamp.wPt * currentScale + "px";
  el.style.height = stamp.hPt * currentScale + "px";
}

function startMove(e, el, stamp) {
  e.preventDefault();
  setActiveStamp(stamp.id);
  el.setPointerCapture(e.pointerId);

  const startX = e.clientX;
  const startY = e.clientY;
  const startLeftPx = stamp.xPt * currentScale;
  const startTopPx = stamp.yPt * currentScale;
  const boundsW = els.overlay.clientWidth;
  const boundsH = els.overlay.clientHeight;
  const wPx = stamp.wPt * currentScale;
  const hPx = stamp.hPt * currentScale;

  function onMove(ev) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    let newLeft = clamp(startLeftPx + dx, 0, Math.max(0, boundsW - wPx));
    let newTop = clamp(startTopPx + dy, 0, Math.max(0, boundsH - hPx));
    stamp.xPt = newLeft / currentScale;
    stamp.yPt = newTop / currentScale;
    el.style.left = newLeft + "px";
    el.style.top = newTop + "px";
  }
  function onUp() {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
  }
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp, { once: true });
}

function startResize(e, el, stamp) {
  e.preventDefault();
  e.stopPropagation();
  setActiveStamp(stamp.id);
  el.setPointerCapture(e.pointerId);

  const startX = e.clientX;
  const startWidthPx = stamp.wPt * currentScale;
  const aspect = stamp.hPt / stamp.wPt;
  const boundsW = els.overlay.clientWidth;
  const boundsH = els.overlay.clientHeight;
  const leftPx = stamp.xPt * currentScale;
  const topPx = stamp.yPt * currentScale;

  function onMove(ev) {
    const dx = ev.clientX - startX;
    let newWidthPx = clamp(startWidthPx + dx, 24, boundsW - leftPx);
    let newHeightPx = newWidthPx * aspect;
    if (topPx + newHeightPx > boundsH) {
      newHeightPx = boundsH - topPx;
      newWidthPx = newHeightPx / aspect;
    }
    stamp.wPt = newWidthPx / currentScale;
    stamp.hPt = newHeightPx / currentScale;
    el.style.width = newWidthPx + "px";
    el.style.height = newHeightPx + "px";
  }
  function onUp() {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
  }
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp, { once: true });
}

/* ---------------- Export ---------------- */

async function downloadStampedPdf() {
  if (!originalBytes || !window.PDFLib) {
    showToast("Belum ada PDF yang diunggah.");
    return;
  }

  const originalLabel = els.downloadBtn.textContent;
  els.downloadBtn.disabled = true;
  els.downloadBtn.textContent = "Memproses…";

  try {
    const { PDFDocument } = window.PDFLib;
    const pdfLibDoc = await PDFDocument.load(originalBytes);
    const pages = pdfLibDoc.getPages();
    const embeddedCache = new Map(); // src -> embedded image (scoped to this export only)

    const byPage = new Map();
    for (const s of stamps) {
      if (!byPage.has(s.page)) byPage.set(s.page, []);
      byPage.get(s.page).push(s);
    }

    for (const [pageNum, list] of byPage) {
      const dims = await getPageDims(pageNum);
      const pdfPage = pages[pageNum - 1];
      if (!pdfPage) continue;

      for (const s of list) {
        let embedded = embeddedCache.get(s.src);
        if (!embedded) {
          const bytes = await fetch(s.src).then((r) => r.arrayBuffer());
          embedded = await pdfLibDoc.embedPng(bytes);
          embeddedCache.set(s.src, embedded);
        }
        const x = s.xPt;
        const y = dims.h - s.yPt - s.hPt;
        pdfPage.drawImage(embedded, { x, y, width: s.wPt, height: s.hPt });
      }
    }

    const outBytes = await pdfLibDoc.save();
    const blob = new Blob([outBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sourceFileName}-bercap.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast("PDF berhasil diunduh.");
  } catch (err) {
    console.error(err);
    showToast("Gagal membuat PDF. Coba lagi.");
  } finally {
    els.downloadBtn.disabled = false;
    els.downloadBtn.textContent = originalLabel;
  }
}

/* ---------------- Utilities ---------------- */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function showToast(msg, duration = 3200) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, duration);
}
