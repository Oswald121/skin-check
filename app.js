// app.js (ES module)
// IMPORTANT: in index.html use: <script type="module" src="app.js"></script>

import { Client } from "https://cdn.jsdelivr.net/npm/@gradio/client/+esm";

// ========================================
// CONFIG
// ========================================
// Your Hugging Face Space ID (username/space_name):
const SPACE_ID = "ElGatito12/ham10000-efficientnet-b0-binary";

// Your Gradio api_name in app.py was: api_name="predict"
// That maps to endpoint path "/predict"
const GRADIO_ENDPOINT = "/predict";

// Client-side file limit to keep things snappy (upload size, not model quality)
const MAX_MB = 8;

// Optional: downscale big images in-browser before upload (faster, still good quality)
const ENABLE_DOWNSCALE = true;
const DOWNSCALE_MAX_DIM = 1400; // px, max width/height
const DOWNSCALE_JPEG_QUALITY = 0.9;

// ========================================
// DOM
// ========================================
const fileInput = document.getElementById("fileInput");
const dropzone = document.getElementById("dropzone");
const previewWrap = dropzone.querySelector(".preview-wrap");
const preview = document.getElementById("preview");
const fileMeta = document.getElementById("fileMeta");
const clearBtn = document.getElementById("clearBtn");

const analyzeBtn = document.getElementById("analyzeBtn");
const analyzeText = document.getElementById("analyzeText");
const spinner = document.getElementById("spinner");
const demoBtn = document.getElementById("demoBtn");

const resultsCard = document.getElementById("resultsCard");
const statusPill = document.getElementById("statusPill");
const scorePct = document.getElementById("scorePct");
const thresholdVal = document.getElementById("thresholdVal");
const modelLabel = document.getElementById("modelLabel");
const summaryTitle = document.getElementById("summaryTitle");
const summaryText = document.getElementById("summaryText");
const chips = document.getElementById("chips");
const recs = document.getElementById("recs");
const rawJson = document.getElementById("rawJson");

const ring = document.querySelector(".ring-fg");

const themeBtn = document.getElementById("themeBtn");
const themeIcon = themeBtn.querySelector(".icon");

// ========================================
// STATE
// ========================================
let currentFile = null;          // File user selected
let currentUploadFile = null;    // File we actually send (maybe downscaled)
let gradioClientPromise = null;  // cached connect promise

// ========================================
// THEME
// ========================================
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

// ========================================
// HELPERS
// ========================================
function bytesToMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function setLoading(isLoading) {
  spinner.style.display = isLoading ? "inline-block" : "none";
  analyzeText.textContent = isLoading ? "Analyzing…" : "Analyze";
  analyzeBtn.disabled = isLoading || !currentUploadFile;
  clearBtn.disabled = isLoading || !currentFile;
}

function setRing(percent) {
  const C = 289; // matches CSS
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

function buildRecommendations(prob, label) {
  const band = riskBand(prob).name;

  const base = [
    { b: "Photo quality matters:", t: "Retake in bright indirect light, keep the lesion centered, avoid flash glare." },
    { b: "If concerned:", t: "Contact a licensed clinician—especially for new, changing, bleeding, or painful lesions." },
  ];

  if (label === "malignant-ish") {
    return [
      { b: "Don’t ignore it:", t: "This result suggests higher risk. Consider booking a dermatology appointment soon." },
      { b: "Track changes:", t: "Monitor size/color/border changes and take consistent photos weekly." },
      ...base,
      { b: "Risk band:", t: `${band} (based on model probability).` },
    ];
  }

  return [
    { b: "Likely lower risk:", t: "This looks low risk per the model, but false negatives are possible." },
    { b: "Keep an eye on it:", t: "If it changes or worries you, get professional evaluation." },
    ...base,
    { b: "Risk band:", t: `${band} (based on model probability).` },
  ];
}

function buildChips(prob, threshold) {
  const band = riskBand(prob).name;
  const pct = Math.round(prob * 100);
  return [
    `Risk: ${band}`,
    `Score: ${pct}%`,
    `Threshold: ${threshold}`,
  ];
}

function showPreview(file) {
  preview.src = URL.createObjectURL(file);
  previewWrap.style.display = "block";
  fileMeta.textContent = `${file.name} • ${bytesToMB(file.size)} MB`;
  clearBtn.disabled = false;
}

function resetAll() {
  currentFile = null;
  currentUploadFile = null;
  fileInput.value = "";
  previewWrap.style.display = "none";
  clearBtn.disabled = true;
  analyzeBtn.disabled = true;
  resultsCard.hidden = true;
}

function pickRingColor(prob) {
  const band = riskBand(prob);
  const color = getComputedStyle(document.body).getPropertyValue(band.colorVar).trim();
  ring.style.stroke = color;
  statusPill.style.borderColor = color;
  statusPill.style.color = color;
}

// ========================================
// OPTIONAL DOWNSCALE (returns File)
// ========================================
async function maybeDownscale(file) {
  if (!ENABLE_DOWNSCALE) return file;

  // Load image into <img>
  const img = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = reject;
    im.src = url;
  });

  const w = img.width;
  const h = img.height;
  const scale = Math.min(1, DOWNSCALE_MAX_DIM / Math.max(w, h));
  if (scale === 1) return file;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", DOWNSCALE_JPEG_QUALITY);
  });

  // Keep a sensible name
  const newName = file.name.replace(/\.\w+$/, "") + "_scaled.jpg";
  return new File([blob], newName, { type: "image/jpeg" });
}

// ========================================
// GRADIO CLIENT
// ========================================
function getClient() {
  if (!gradioClientPromise) {
    gradioClientPromise = Client.connect(SPACE_ID);
  }
  return gradioClientPromise;
}

async function callPredictApi(fileToSend) {
  const client = await getClient();

  // Gradio will handle upload + call internally
  const result = await client.predict(GRADIO_ENDPOINT, [fileToSend]);

  // result.data is typically an array of outputs
  // Your output is JSON -> usually result.data[0] is the object
  const output = Array.isArray(result?.data) ? result.data[0] : result;
  return output;
}

// ========================================
// RESULT RENDERING
// ========================================
function paintResult(output) {
  // Expected:
  // { label: "benign-ish"/"malignant-ish", prob_malignant: 0.123, threshold: 0.2, note: ... }
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
      "The model thinks this image resembles patterns it learned from higher-risk (malignant-ish) examples. This is not a diagnosis—use it as a signal to consider professional evaluation.";
  } else {
    summaryTitle.textContent = "Likely lower-risk pattern";
    summaryText.textContent =
      "The model thinks this image resembles lower-risk (benign-ish) examples. It can still be wrong, especially with blur, glare, or unusual cases—monitor and seek care if concerned.";
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

// ========================================
// FILE HANDLING
// ========================================
async function handleFile(file) {
  if (!file) return;

  if (file.size > MAX_MB * 1024 * 1024) {
    alert(`That file is ${bytesToMB(file.size)} MB. Please choose a file under ~${MAX_MB} MB.`);
    return;
  }

  currentFile = file;
  showPreview(file);
  setLoading(true);

  try {
    currentUploadFile = await maybeDownscale(file);
    analyzeBtn.disabled = false;
  } catch (e) {
    console.error(e);
    alert("Could not process that image. Try another one.");
    resetAll();
  } finally {
    setLoading(false);
  }
}

// Input change
fileInput.addEventListener("change", (e) => {
  handleFile(e.target.files?.[0]);
});

// Drag-drop
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

// Click dropzone to open file picker (but not when clicking buttons)
dropzone.addEventListener("click", (e) => {
  if (e.target.closest(".btn")) return;
  fileInput.click();
});
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

clearBtn.addEventListener("click", () => {
  resetAll();
});

// ========================================
// ANALYZE
// ========================================
analyzeBtn.addEventListener("click", async () => {
  if (!currentUploadFile) return;

  setLoading(true);

  try {
    const output = await callPredictApi(currentUploadFile);
    paintResult(output);
  } catch (err) {
    console.error(err);

    alert(
      "Could not reach the prediction API.\n\n" +
      "Common causes:\n" +
      "• Space is sleeping (try again in ~10–30s)\n" +
      "• Space is private\n" +
      "• Temporary HF outage\n\n" +
      `Details: ${err?.message ?? err}`
    );
  } finally {
    setLoading(false);
  }
});

// Demo mode (no API call)
demoBtn.addEventListener("click", () => {
  const fake = {
    label: "benign-ish",
    prob_malignant: 0.022,
    threshold: 0.20,
    note: "Educational demo. Not medical advice."
  };
  paintResult(fake);
});

// Optional: warm up the connection early (helps first click feel faster)
(async function warmup() {
  try {
    await getClient();
  } catch {
    // ignore; user can still click Analyze later
  }
})();
