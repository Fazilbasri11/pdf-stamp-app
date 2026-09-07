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
  els.dropzone = document.getElementById("file-dropzone");
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

  wireFileDropzone();
}

// Lets a PDF be dropped anywhere on the page (from the Finder/Explorer, or
// from the Files app on iPad) to load it, replacing whatever was open.
function wireFileDropzone() {
  let dragCounter = 0;

  function hasFiles(e) {
    return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  }

  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounter++;
    els.dropzone.classList.add("show");
  });

  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });

  window.addEventListener("dragleave", () => {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) els.dropzone.classList.remove("show");
  });

  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounter = 0;
    els.dropzone.classList.remove("show");
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      showToast("File yang diseret bukan PDF.");
      return;
    }
    handleFileUpload(file);
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
    rotDeg: 0,
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

/* ---------------- Overlay rendering & drag / 9-point transform ---------------- */

// Each handle: its own fractional position on the box, and which opposite
// point stays fixed (the "anchor") while it's being dragged. "axis" says
// whether it changes width, height, or both.
const HANDLE_DEFS = {
  nw: { self: { x: 0, y: 0 }, anchor: { x: 1, y: 1 }, axis: "both", cursor: "nwse-resize" },
  ne: { self: { x: 1, y: 0 }, anchor: { x: 0, y: 1 }, axis: "both", cursor: "nesw-resize" },
  se: { self: { x: 1, y: 1 }, anchor: { x: 0, y: 0 }, axis: "both", cursor: "nwse-resize" },
  sw: { self: { x: 0, y: 1 }, anchor: { x: 1, y: 0 }, axis: "both", cursor: "nesw-resize" },
  n: { self: { x: 0.5, y: 0 }, anchor: { x: 0.5, y: 1 }, axis: "y", cursor: "ns-resize" },
  s: { self: { x: 0.5, y: 1 }, anchor: { x: 0.5, y: 0 }, axis: "y", cursor: "ns-resize" },
  e: { self: { x: 1, y: 0.5 }, anchor: { x: 0, y: 0.5 }, axis: "x", cursor: "ew-resize" },
  w: { self: { x: 0, y: 0.5 }, anchor: { x: 1, y: 0.5 }, axis: "x", cursor: "ew-resize" },
};
const MIN_STAMP_PT = 16;

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

  for (const key of Object.keys(HANDLE_DEFS)) {
    const h = document.createElement("div");
    h.className = `handle handle-${key}`;
    h.addEventListener("pointerdown", (e) => startResizeHandle(e, el, stamp, key));
    el.appendChild(h);
  }

  const stalk = document.createElement("div");
  stalk.className = "rotate-stalk";
  el.appendChild(stalk);

  const rotateHandle = document.createElement("div");
  rotateHandle.className = "handle-rotate";
  rotateHandle.setAttribute("role", "button");
  rotateHandle.setAttribute("aria-label", "Putar stempel");
  rotateHandle.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  rotateHandle.addEventListener("pointerdown", (e) => startRotate(e, el, stamp));
  el.appendChild(rotateHandle);

  const angleBadge = document.createElement("span");
  angleBadge.className = "angle-badge";
  el.appendChild(angleBadge);

  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".handle, .handle-rotate, .stamp-remove")) return;
    startMove(e, el, stamp);
  });

  return el;
}

function applyStampGeometry(el, stamp) {
  el.style.left = stamp.xPt * currentScale + "px";
  el.style.top = stamp.yPt * currentScale + "px";
  el.style.width = stamp.wPt * currentScale + "px";
  el.style.height = stamp.hPt * currentScale + "px";
  el.style.transform = `rotate(${stamp.rotDeg || 0}deg)`;
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

// General rotation-aware resize: works for all 8 handles. The point
// opposite the dragged handle (the "anchor") stays visually fixed on the
// page — including while the stamp is rotated — by doing the drag math in
// the box's own (rotated) local coordinate frame, then converting back.
function startResizeHandle(e, el, stamp, handleKey) {
  e.preventDefault();
  e.stopPropagation();
  setActiveStamp(stamp.id);
  el.setPointerCapture(e.pointerId);

  const def = HANDLE_DEFS[handleKey];
  const startClientX = e.clientX;
  const startClientY = e.clientY;
  const wStart = stamp.wPt;
  const hStart = stamp.hPt;
  const centerStart = { x: stamp.xPt + wStart / 2, y: stamp.yPt + hStart / 2 };
  const theta = ((stamp.rotDeg || 0) * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  const anchorLocal = { x: (def.anchor.x - 0.5) * wStart, y: (def.anchor.y - 0.5) * hStart };
  const anchorGlobal = {
    x: centerStart.x + (cosT * anchorLocal.x - sinT * anchorLocal.y),
    y: centerStart.y + (sinT * anchorLocal.x + cosT * anchorLocal.y),
  };
  const draggedLocalStart = {
    x: (def.self.x - def.anchor.x) * wStart,
    y: (def.self.y - def.anchor.y) * hStart,
  };

  function onMove(ev) {
    const dxPt = (ev.clientX - startClientX) / currentScale;
    const dyPt = (ev.clientY - startClientY) / currentScale;
    const localDx = cosT * dxPt + sinT * dyPt;
    const localDy = -sinT * dxPt + cosT * dyPt;
    const draggedLocalNew = { x: draggedLocalStart.x + localDx, y: draggedLocalStart.y + localDy };

    let newW = wStart;
    let newH = hStart;
    if (def.axis === "both" || def.axis === "x") newW = Math.max(MIN_STAMP_PT, Math.abs(draggedLocalNew.x));
    if (def.axis === "both" || def.axis === "y") newH = Math.max(MIN_STAMP_PT, Math.abs(draggedLocalNew.y));

    const newCenterLocal = { x: (0.5 - def.anchor.x) * newW, y: (0.5 - def.anchor.y) * newH };
    const newCenter = {
      x: anchorGlobal.x + (cosT * newCenterLocal.x - sinT * newCenterLocal.y),
      y: anchorGlobal.y + (sinT * newCenterLocal.x + cosT * newCenterLocal.y),
    };

    stamp.wPt = newW;
    stamp.hPt = newH;
    stamp.xPt = newCenter.x - newW / 2;
    stamp.yPt = newCenter.y - newH / 2;
    applyStampGeometry(el, stamp);
  }
  function onUp() {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
  }
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp, { once: true });
}

function startRotate(e, el, stamp) {
  e.preventDefault();
  e.stopPropagation();
  setActiveStamp(stamp.id);
  el.setPointerCapture(e.pointerId);

  const rect = el.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const startAngle = (Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180) / Math.PI;
  const startRot = stamp.rotDeg || 0;
  const badge = el.querySelector(".angle-badge");
  if (badge) {
    badge.classList.add("show");
    badge.textContent = Math.round(startRot) + "\u00B0";
  }

  function onMove(ev) {
    const angle = (Math.atan2(ev.clientY - centerY, ev.clientX - centerX) * 180) / Math.PI;
    let next = startRot + (angle - startAngle);
    next = ((next % 360) + 360) % 360;
    if (next > 180) next -= 360;
    stamp.rotDeg = next;
    applyStampGeometry(el, stamp);
    if (badge) badge.textContent = Math.round(next) + "\u00B0";
  }
  function onUp() {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    if (badge) badge.classList.remove("show");
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

        const rotDeg = s.rotDeg || 0;
        if (rotDeg === 0) {
          const x = s.xPt;
          const y = dims.h - s.yPt - s.hPt;
          pdfPage.drawImage(embedded, { x, y, width: s.wPt, height: s.hPt });
        } else {
          // pdf-lib rotates counter-clockwise around the image's own
          // bottom-left corner, in a y-up space — the opposite handedness
          // from the CSS rotation (clockwise, y-down) used on screen. We
          // negate the angle and solve for the bottom-left anchor that
          // keeps the same visual center after that rotation is applied.
          const centerX = s.xPt + s.wPt / 2;
          const centerY = dims.h - (s.yPt + s.hPt / 2);
          const phi = (-rotDeg * Math.PI) / 180;
          const cosP = Math.cos(phi);
          const sinP = Math.sin(phi);
          const halfW = s.wPt / 2;
          const halfH = s.hPt / 2;
          const anchorX = centerX - (cosP * halfW - sinP * halfH);
          const anchorY = centerY - (sinP * halfW + cosP * halfH);
          pdfPage.drawImage(embedded, {
            x: anchorX,
            y: anchorY,
            width: s.wPt,
            height: s.hPt,
            rotate: window.PDFLib.degrees(-rotDeg),
          });
        }
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
