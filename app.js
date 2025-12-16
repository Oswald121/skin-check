import { Client } from "https://cdn.jsdelivr.net/npm/@gradio/client/+esm";

// ============================
// CONFIG
// ============================
const SPACE_ID = "ElGatito12/ham10000-efficientnet-b0-binary";
const GRADIO_ENDPOINT = "/predict";

const MAX_MB = 12;                 // allow bigger picks; we compress anyway
const MAX_DIM = 1400;              // downscale longest side to this (mobile-friendly)
const JPEG_QUALITY = 0.9;          // 0.85–0.95 is a good range

// ============================
// DOM
// ============================
const galleryInput = document.getElementById("galleryInput");
const cameraInput  = document.getElementById("cameraInput");
const dropzone     = document.getElementById("dropzone");
const previewWrap  = dropzone.querySelector(".preview-wrap");
const preview      = document.getElementById("preview");
const fileMeta     = document.getElementById("fileMeta");
const clearBtn     = document.getElementById("clearBtn");

const analyzeBtn   = document.getElementById("analyzeBtn");
const analyzeText  = document.getElementById("analyzeText");
const spinner      = document.getElementById("spinner");
const demoBtn      = document.getElementById("demoBtn");

const resultsCard  = document.getElementById("resultsCard");
const statusPill   = document.getElementById("statusPill");
const scorePct     = document.getElementById("scorePct");
const thresholdVal = document.getElementById("thresholdVal");
const modelLabel   = document.getElementById("modelLabel");
const summaryTitle = document.getElementById("summaryTitle");
const summaryText  = document.getElementById("summaryText");
const chips        = document.getElementById("chips");
const recs         = document.getElementById("recs");
const rawJson      = document.getElementById("rawJson");
const ring         = document.querySelector(".ring-fg");

const themeBtn     = document.getElementById("themeBtn");
const themeIcon    = themeBtn.querySelector(".icon");

// ============================
// STATE
// ============================
let originalFile = null;     // what user selected
let uploadFile   = null;     // JPEG we send to HF (converted)
let clientPromise = null;

// ============================
// THEME
// ============================
(function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "light") {
    document.body.classList.add("light");
    themeIcon.textContent = "☀";
  }
})();

themeBtn.addEventListener("click", () => {
  document.body.classList.toggle("light");
  const isLight = document.body.classList.contains("light");
  localStorage.setItem("theme", isLight ? "light" : "dark");
  themeIcon.textContent = isLight ? "☀" : "☾";
});

// ============================
// UI helpers
// ============================
function bytesToMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function setLoading(isLoading) {
  spinner.style.display = isLoading ? "inline-block" : "none";
  analyzeText.textContent = isLoading ? "Analyzing…" : "Analyze";
  analyzeBtn.disabled = isLoading || !uploadFile;
  clearBtn.disabled = isLoading || !originalFile;
}

function resetAll() {
  originalFile = null;
  uploadFile = null;
  galleryInput.value = "";
  cameraInput.value = "";
  previewWrap.style.display = "none";
  clearBtn.disabled = true;
  analyzeBtn.disabled = true;
  resultsCard.hidden = true;
  fileMeta.textContent = "";
}

function showPreview(file) {
  preview.src = URL.createObjectURL(file);
  previewWrap.style.display = "block";
  clearBtn.disabled = false;
}

function setRing(percent) {
  const C = 289;
  const p = Math.max(0, Math.min(100, percent));
  const offset = C - (C * p / 100);
  ring.style.strokeDasharray = `${C}`;
  ring.style.strokeDashoffset = `${offset}`;
}

function riskBand(prob) {
  if (prob < 0.02) return { name: "Very low", colorVar: "--good" };
  if (prob < 0.10) return { name: "Low", colorVar: "--good" };
  if (prob < 0.30) return { name: "Moderate", colorVar: "--warn" };
  if (prob < 0.60) return { name: "High", colorVar: "--warn" };
  return { name: "Very high", colorVar: "--bad" };
}

function pickRingColor(prob) {
  const band = riskBand(prob);
  const color = getComputedStyle(document.body).getPropertyValue(band.colorVar).trim();
  ring.style.stroke = color;
  statusPill.style.borderColor = color;
  statusPill.style.color = color;
}

function buildChips(prob, threshold) {
  const band = riskBand(prob).name;
  const pct = Math.round(prob * 100);
  return [`Risk: ${band}`, `Score: ${pct}%`, `Threshold: ${threshold}`];
}

function buildRecommendations(prob, label) {
  const band = riskBand(prob).name;
  const base = [
    { b: "Photo quality matters:", t: "Retake in bright indirect light, keep lesion centered, avoid flash glare." },
    { b: "If concerned:", t: "Contact a licensed clinician—especially for new, changing, bleeding, or painful lesions." },
  ];

  if (label === "malignant-ish") {
    return [
      { b: "Higher-risk signal:", t: "Consider booking a dermatology appointment soon." },
      { b: "Track changes:", t: "Monitor size/color/border changes and take consistent photos over time." },
      ...base,
      { b: "Risk band:", t: `${band} (based on model probability).` },
    ];
  }

  return [
    { b: "Lower-risk signal:", t: "This looks low risk per the model, but false negatives are possible." },
    { b: "Keep an eye on it:", t: "If it changes or worries you, seek professional evaluation." },
    ...base,
    { b: "Risk band:", t: `${band} (based on model probability).` },
  ];
}

function paintResult(output) {
  const label = output?.label ?? "unknown";
  const prob = Number(output?.prob_malignant ?? output?.prob ?? 0);
  const threshold = output?.threshold ?? "—";

  const pct = Math.round(prob * 100);
  scorePct.textContent = `${pct}%`;
  thresholdVal.textContent = `${threshold}`;
  modelLabel.textContent = `${label}`;

  setRing(pct);
  pickRingColor(prob);
  statusPill.textContent = (label === "malignant-ish") ? "Higher risk" : "Lower risk";

  if (label === "malignant-ish") {
    summaryTitle.textContent = "Possible higher-risk pattern";
    summaryText.textContent =
      "The model thinks this resembles higher-risk examples. This is not a diagnosis—consider professional evaluation.";
  } else {
    summaryTitle.textContent = "Likely lower-risk pattern";
    summaryText.textContent =
      "The model thinks this resembles lower-risk examples. It can still be wrong—monitor and seek care if concerned.";
  }

  chips.innerHTML = "";
  buildChips(prob, threshold).forEach((t) => {
    const el = document.createElement("div");
    el.className = "chip";
    el.textContent = t;
    chips.appendChild(el);
  });

  recs.innerHTML = "";
  buildRecommendations(prob, label).forEach((item) => {
    const li = document.createElement("li");
    li.innerHTML = `<b>${item.b}</b> ${item.t}`;
    recs.appendChild(li);
  });

  rawJson.textContent = JSON.stringify(output, null, 2);

  resultsCard.hidden = false;
  resultsCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ============================
// iPhone-safe conversion: File -> JPEG File
// ============================
function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)?.[1] || "image/jpeg";
  const bin = atob(b64);
  const len = bin.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function decodeImage(file) {
  // Prefer createImageBitmap (fast), fallback to <img>
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file);
    } catch {}
  }

  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

async function prepareUploadJpeg(file) {
  const decoded = await decodeImage(file);

  const w = decoded.width;
  const h = decoded.height;

  const scale = Math.min(1, MAX_DIM / Math.max(w, h));
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(decoded, 0, 0, outW, outH);

  // If decoded is ImageBitmap, close to free memory
  if (decoded && typeof decoded.close === "function") decoded.close();

  let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));

  // Some iOS versions can return null; fallback to dataURL
  if (!blob) {
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    blob = dataUrlToBlob(dataUrl);
  }

  const safeBase = (file.name || "upload").replace(/\.\w+$/, "");
  const jpegName = `${safeBase}.jpg`;
  return new File([blob], jpegName, { type: "image/jpeg" });
}

// ============================
// Gradio client
// ============================
function getClient() {
  if (!clientPromise) clientPromise = Client.connect(SPACE_ID);
  return clientPromise;
}

async function callPredict(fileToSend) {
  const client = await getClient();
  const result = await client.predict(GRADIO_ENDPOINT, [fileToSend]);
  return Array.isArray(result?.data) ? result.data[0] : result;
}

// ============================
// Handlers
// ============================
async function handleFile(file) {
  if (!file) return;

  if (file.size > MAX_MB * 1024 * 1024) {
    alert(`That file is ${bytesToMB(file.size)} MB. Please choose a file under ~${MAX_MB} MB.`);
    return;
  }

  originalFile = file;
  showPreview(file);
  setLoading(true);

  try {
    uploadFile = await prepareUploadJpeg(file);

    fileMeta.textContent =
      `Selected: ${file.name} (${bytesToMB(file.size)} MB) • ` +
      `Uploading: ${uploadFile.name} (${bytesToMB(uploadFile.size)} MB, JPEG)`;

    analyzeBtn.disabled = false;
  } catch (e) {
    console.error(e);
    alert("Could not read/convert that image on this device. Try another photo.");
    resetAll();
  } finally {
    setLoading(false);
  }
}

galleryInput.addEventListener("change", (e) => handleFile(e.target.files?.[0]));
cameraInput.addEventListener("change", (e) => handleFile(e.target.files?.[0]));

// Desktop drag-drop
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.style.borderColor = "rgba(124,92,255,.65)";
});
dropzone.addEventListener("dragleave", () => {
  dropzone.style.borderColor = "";
});
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.style.borderColor = "";
  handleFile(e.dataTransfer.files?.[0]);
});

// Clicking empty zone opens Gallery by default
dropzone.addEventListener("click", (e) => {
  if (e.target.closest(".btn")) return;
  galleryInput.click();
});
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    galleryInput.click();
  }
});

clearBtn.addEventListener("click", () => resetAll());

analyzeBtn.addEventListener("click", async () => {
  if (!uploadFile) return;

  setLoading(true);
  try {
    const output = await callPredict(uploadFile);
    paintResult(output);
  } catch (err) {
    console.error(err);
    alert(
      "Prediction failed.\n\n" +
      "Common causes:\n" +
      "• Space is sleeping (try again in ~10–30s)\n" +
      "• Network/cellular hiccup\n\n" +
      `Details: ${err?.message ?? err}`
    );
  } finally {
    setLoading(false);
  }
});

demoBtn.addEventListener("click", () => {
  paintResult({
    label: "benign-ish",
    prob_malignant: 0.022,
    threshold: 0.20,
    note: "Educational demo. Not medical advice."
  });
});

// Warm up connection (optional)
(async function warmup() {
  try { await getClient(); } catch {}
})();
