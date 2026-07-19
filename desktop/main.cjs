const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { randomUUID } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const jobs = new Map();
const selections = new Map();
const importedAssets = new Map();
const children = new Set();
const supportedExtensions = new Set([".ply", ".spz", ".splat"]);
let server;
let processorPath;
let jobsFile;
let persistTimer;
let quitting = false;
let mainWindow;
const MAX_CONCURRENT_JOBS = 1;
const processorQualitySupport = new Map();
const testAssetRoot = process.env.GAUSS_TEST_ASSET_ROOT
  ? path.resolve(process.env.GAUSS_TEST_ASSET_ROOT)
  : null;

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function safeName(value) {
  let decoded = "model.ply";
  try { decoded = decodeURIComponent(value || decoded); } catch {}
  return path.basename(decoded).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 180) || "model.ply";
}

function publicJob(job) {
  return {
    id: job.id,
    name: job.name,
    bytes: job.bytes,
    received: job.received,
    state: job.state,
    progress: job.progress,
    stage: job.stage,
    memoryLimitMb: job.memoryLimitMb,
    qualityProfile: job.qualityProfile,
    assetUrl: job.assetUrl,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    outputDir: job.outputDir,
    acceleration: job.acceleration || "CPU 多线程",
    canRetry: Boolean(job.inputPath && fs.existsSync(job.inputPath)),
    log: job.log.slice(-8),
  };
}

function persistJobsSoon() {
  if (!jobsFile || quitting) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const records = [...jobs.values()].map((job) => ({
      id: job.id, name: job.name, bytes: job.bytes, received: job.received,
      state: job.state, progress: job.progress, stage: job.stage,
      memoryLimitMb: job.memoryLimitMb, qualityProfile: job.qualityProfile,
      outputDir: job.outputDir, scratchDir: job.scratchDir, inputPath: job.inputPath, assetFile: job.assetFile,
      createdAt: job.createdAt, completedAt: job.completedAt,
      error: job.error, acceleration: job.acceleration,
    }));
    const temporary = `${jobsFile}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, jobs: records }, null, 2));
      fs.renameSync(temporary, jobsFile);
    } catch (error) { console.error("Unable to persist jobs", error); }
  }, 150);
}

function loadPersistedJobs() {
  if (!fs.existsSync(jobsFile)) return;
  try {
    const data = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
    for (const record of Array.isArray(data.jobs) ? data.jobs : []) {
      const assetFile = record.assetFile || (record.outputDir && path.join(record.outputDir, "manifest.json"));
      const ready = Boolean(assetFile && fs.existsSync(assetFile));
      const wasActive = ["uploading", "queued", "processing", "cancelling"].includes(record.state);
      const job = {
        ...record,
        state: ready ? "ready" : wasActive ? "interrupted" : record.state,
        progress: ready ? 100 : record.progress || 0,
        stage: ready ? "已完成，可直接打开" : wasActive ? "上次退出时已停止" : record.stage,
        error: ready ? undefined : wasActive ? "程序退出后任务未自动恢复，请重新添加源模型" : record.error,
        assetFile: ready ? assetFile : record.assetFile,
        assetRoot: ready ? path.dirname(assetFile) : undefined,
        assetUrl: ready ? `/job-assets/${record.id}/${encodeURIComponent(path.basename(assetFile))}` : undefined,
        log: [], process: undefined,
      };
      jobs.set(job.id, job);
    }
  } catch (error) { console.error("Unable to load job history", error); }
}

function clampQualityProfile(value) {
  return ["original", "high", "compact"].includes(value) ? value : "original";
}

function systemSnapshot() {
  const totalMemoryMb = Math.floor(os.totalmem() / 1048576);
  const freeMemoryMb = Math.floor(os.freemem() / 1048576);
  return {
    totalMemoryMb,
    freeMemoryMb,
    maxMemoryMb: Math.max(512, Math.min(32768, Math.floor(totalMemoryMb * 0.75 / 256) * 256)),
    cpuCount: os.availableParallelism?.() || os.cpus().length,
    cpuModel: os.cpus()[0]?.model || "Unknown CPU",
    platform: process.platform,
  };
}

function clampMemoryLimit(value) {
  const maximum = systemSnapshot().maxMemoryMb;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.min(4096, maximum);
  return Math.max(512, Math.min(maximum, Math.round(numeric / 256) * 256));
}

function recommendMemory(bytes, splats, extension) {
  const system = systemSnapshot();
  const compressedFactor = extension === ".spz" ? 8 : extension === ".splat" ? 2 : 1;
  const fileEquivalentGiB = bytes * compressedFactor / 1073741824;
  const splatEquivalentGiB = splats ? splats * 64 / 1073741824 : 0;
  const dataPressure = Math.max(0.05, fileEquivalentGiB, splatEquivalentGiB);
  const desired = 1024 + Math.sqrt(dataPressure) * 1024;
  const safeAvailable = Math.max(512, Math.min(system.totalMemoryMb * 0.5, system.freeMemoryMb * 0.65));
  const recommendedMemoryMb = clampMemoryLimit(Math.min(desired, safeAvailable));
  return { ...system, recommendedMemoryMb };
}

function readPlyCount(filePath) {
  const handle = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const count = fs.readSync(handle, buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, count).toString("utf8");
    const match = /(?:^|\n)element vertex\s+(\d+)/i.exec(header);
    return match ? Number(match[1]) : undefined;
  } finally {
    fs.closeSync(handle);
  }
}

function readSpzCount(filePath) {
  return new Promise((resolve) => {
    const input = fs.createReadStream(filePath);
    const gunzip = zlib.createGunzip();
    let bytes = Buffer.alloc(0);
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      input.destroy();
      gunzip.destroy();
      resolve(value);
    };
    input.on("error", () => finish(undefined));
    gunzip.on("error", () => finish(undefined));
    gunzip.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 12) finish(bytes.readUInt32LE(0) === 0x5053474e ? bytes.readUInt32LE(8) : undefined);
    });
    gunzip.on("end", () => finish(undefined));
    input.pipe(gunzip);
  });
}

async function analyzeLocalModel(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("模型路径无效");
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error("请选择一个模型文件");
  const extension = path.extname(filePath).toLowerCase();
  if (!supportedExtensions.has(extension)) throw new Error(`外存模式暂不支持 ${extension || "未知"} 格式，请先转换为 PLY、SPZ 或 SPLAT`);
  let splats;
  if (extension === ".splat") splats = Math.floor(stats.size / 32);
  else if (extension === ".ply") splats = readPlyCount(filePath);
  else if (extension === ".spz") splats = await readSpzCount(filePath);
  const selectionId = randomUUID();
  selections.set(selectionId, { filePath, createdAt: Date.now() });
  return {
    selectionId,
    name: path.basename(filePath),
    bytes: stats.size,
    format: extension.slice(1).toUpperCase(),
    splats,
    analysis: splats ? "已读取格式头，获得精确高斯数量" : "已依据文件大小与格式估算",
    ...recommendMemory(stats.size, splats, extension),
  };
}

function openExistingAsset(inputPath) {
  if (typeof inputPath !== "string" || !path.isAbsolute(inputPath))
    throw new Error("LOD 路径无效");
  let filePath = inputPath;
  const inputStats = fs.statSync(filePath);
  if (inputStats.isDirectory()) filePath = path.join(filePath, "manifest.json");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile())
    throw new Error("目录中没有找到 manifest.json");
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== ".json" && extension !== ".rad")
    throw new Error("请选择 LOD 目录中的 manifest.json 或 RAD 文件");
  let manifest;
  if (extension === ".json") {
    try {
      manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      throw new Error("manifest.json 无法解析");
    }
    if (manifest.format !== "spark-rad-manifest-v1" || !Array.isArray(manifest.tiles))
      throw new Error("这不是有效的 Gauss Stream LOD manifest");
  }
  const existing = [...jobs.values()].find((job) => job.assetFile && path.resolve(job.assetFile) === path.resolve(filePath));
  if (existing) return publicJob(existing);
  const id = randomUUID();
  const root = path.dirname(filePath);
  const stats = fs.statSync(filePath);
  const job = {
    id,
    name: extension === ".json" ? path.basename(root) : path.basename(filePath),
    bytes: stats.size,
    received: stats.size,
    state: "ready",
    progress: 100,
    stage: "已导入，可直接打开",
    memoryLimitMb: Number(manifest?.memoryLimitMb || 0),
    qualityProfile: manifest?.qualityProfile || "unknown",
    outputDir: root,
    assetFile: filePath,
    assetRoot: root,
    assetUrl: `/job-assets/${id}/${encodeURIComponent(path.basename(filePath))}`,
    createdAt: stats.mtimeMs || Date.now(),
    completedAt: stats.mtimeMs || Date.now(),
    acceleration: "已处理模型",
    log: [],
  };
  jobs.set(id, job);
  persistJobsSoon();
  return publicJob(job);
}

function updateProgress(job, line) {
  const text = line.trim();
  if (!text) return;
  job.log.push(text);
  if (job.log.length > 50) job.log.shift();
  if (text.includes("STREAM_PHASE decode")) { job.stage = "流式解码并写入磁盘"; job.progress = 18; }
  else if (text.includes("STREAM_PHASE bucket")) { job.stage = "空间分桶（内存有界）"; job.progress = 35; }
  else if (text.includes("STREAM_PHASE lod")) { job.stage = "逐桶构建 Bhatt LOD"; job.progress = 48; }
  else if (text.includes("STREAM_PHASE manifest")) { job.stage = "生成流式场景清单"; job.progress = 96; }
  const tile = /STREAM_TILE_DONE (\d+) (\d+)/.exec(text);
  if (tile) job.progress = Math.max(job.progress, 48 + Number(tile[1]) / Number(tile[2]) * 46);
  const threads = /STREAM_THREADS (\d+)/.exec(text);
  if (threads) job.acceleration = `CPU 多线程 · ${threads[1]} 线程`;
  persistJobsSoon();
}

function resourcePaths() {
  if (app.isPackaged) {
    return {
      viewer: path.join(process.resourcesPath, "web", "index.html"),
      spark: path.join(process.resourcesPath, "web", "spark.module.js"),
      three: path.join(process.resourcesPath, "web", "three.module.js"),
      threeCore: path.join(process.resourcesPath, "web", "three.core.js"),
      orbitControls: path.join(process.resourcesPath, "web", "OrbitControls.js"),
      processor: path.join(process.resourcesPath, "bin", "build-lod.exe"),
    };
  }
  const root = path.resolve(__dirname, "..");
  return {
    viewer: path.join(root, "examples", "mobile-lod-viewer", "index.html"),
    spark: path.join(root, "dist", "spark.module.js"),
    three: path.join(root, "node_modules", "three", "build", "three.module.js"),
    threeCore: path.join(root, "node_modules", "three", "build", "three.core.js"),
    orbitControls: path.join(root, "node_modules", "three", "examples", "jsm", "controls", "OrbitControls.js"),
    processor: path.join(root, "rust", "target", "release", "build-lod.exe"),
  };
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function serveFile(req, res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end("Not found"); return; }
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType(file));
  if (!range) {
    res.setHeader("Content-Length", size);
    res.writeHead(200);
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file).pipe(res);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end || start >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
  res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

function removeScratch(job) {
  if (!job.scratchDir) return;
  fs.rm(job.scratchDir, { recursive: true, force: true }, () => {});
}

function supportsStreamQuality(processor) {
  if (processorQualitySupport.has(processor)) return processorQualitySupport.get(processor);
  const probe = spawnSync(processor, [], { windowsHide: true, encoding: "utf8" });
  const supported = `${probe.stdout || ""}\n${probe.stderr || ""}`.includes("--stream-quality");
  processorQualitySupport.set(processor, supported);
  return supported;
}

function startProcessor(job, inputPath, processor) {
  const supportsQuality = supportsStreamQuality(processor);
  if (!supportsQuality && job.qualityProfile !== "compact") {
    job.state = "error";
    job.stage = "原画质处理器尚未编译";
    job.error = "当前 release build-lod.exe 仍是旧版，只能生成紧凑量化 RAD。源码已经支持原画质 F32；按当前开发安排，需稍后重新编译处理器后再构建。";
    return;
  }
  job.state = "processing";
  job.stage = `启动 ${(job.memoryLimitMb / 1024).toFixed(job.memoryLimitMb % 1024 ? 1 : 0)} GB 外存 LOD 处理器`;
  job.progress = 17;
  const args = [
    "--streaming",
    `--memory-limit-mb=${job.memoryLimitMb}`,
    ...(supportsQuality ? [`--stream-quality=${job.qualityProfile}`] : []),
    `--stream-output-dir=${job.outputDir}`,
    `--stream-scratch-dir=${job.scratchDir}`,
    `--threads=${job.threads || 0}`,
    `--parent-pid=${process.pid}`,
    inputPath,
  ];
  const child = spawn(processor, args, { windowsHide: true });
  job.process = child;
  job.pid = child.pid;
  job.acceleration = `CPU 多线程 · ${job.threads || "自动"} 线程`;
  children.add(child);
  persistJobsSoon();
  const consume = (data) => {
    for (const line of data.toString("utf8").split(/\r?\n/))
      updateProgress(job, line);
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  child.on("error", (error) => { job.state = "error"; job.stage = "处理器启动失败"; job.error = error.message; persistJobsSoon(); pumpQueue(); });
  child.on("close", (code) => {
    children.delete(child);
    job.process = undefined;
    if (job.state === "cancelled") { removeScratch(job); persistJobsSoon(); pumpQueue(); return; }
    const manifest = path.join(job.outputDir, "manifest.json");
    if (code === 0 && fs.existsSync(manifest)) {
      job.state = "ready";
      job.stage = "可开始流式预览";
      job.progress = 100;
      job.assetRoot = job.outputDir;
      job.assetFile = manifest;
      job.assetUrl = `/job-assets/${job.id}/manifest.json`;
      job.completedAt = Date.now();
    } else {
      job.state = "error";
      job.stage = "LOD 处理失败";
      job.error = job.log.at(-1) || `处理器退出码 ${code}`;
      removeScratch(job);
    }
    persistJobsSoon();
    pumpQueue();
  });
}

function activeJobCount() {
  return children.size;
}

function pumpQueue() {
  if (quitting || !processorPath) return;
  while (activeJobCount() < MAX_CONCURRENT_JOBS) {
    const next = [...jobs.values()].find((job) => job.state === "queued" && job.inputPath && fs.existsSync(job.inputPath));
    if (!next) break;
    startProcessor(next, next.inputPath, processorPath);
  }
}

function enqueueJob(job) {
  job.state = "queued";
  job.stage = activeJobCount() ? "等待前一个任务完成" : "等待启动处理器";
  persistJobsSoon();
  setImmediate(pumpQueue);
}

function directJob(filePath, resources, memoryLimitMb, qualityProfile) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("模型路径无效");
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error("请选择一个模型文件");
  const extension = path.extname(filePath).toLowerCase();
  if (!supportedExtensions.has(extension)) throw new Error(`外存模式暂不支持 ${extension || "未知"} 格式，请先转换为 PLY、SPZ 或 SPLAT`);

  const id = randomUUID();
  const parent = path.dirname(filePath);
  const stem = safeName(path.basename(filePath, extension));
  const suffix = id.slice(0, 8);
  const job = {
    id,
    name: path.basename(filePath),
    bytes: stats.size,
    received: stats.size,
    state: "queued",
    progress: 16,
    stage: "已读取本地文件，启动外存处理",
    memoryLimitMb: clampMemoryLimit(memoryLimitMb),
    qualityProfile: clampQualityProfile(qualityProfile),
    log: [],
    outputDir: path.join(parent, `${stem}-lod-stream-${suffix}`),
    scratchDir: path.join(parent, `.${stem}-lod-scratch-${suffix}`),
    inputPath: filePath,
    createdAt: Date.now(),
    threads: 0,
  };
  jobs.set(id, job);
  enqueueJob(job);
  return publicJob(job);
}

function registerDesktopIpc(resources) {
  ipcMain.handle("desktop:pick-model", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: "选择高斯模型",
      buttonLabel: "分析模型",
      properties: ["openFile", "dontAddToRecent"],
      filters: [
        { name: "Gaussian Splat 模型", extensions: ["ply", "spz", "splat"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return analyzeLocalModel(result.filePaths[0]);
  });
  ipcMain.handle("desktop:inspect-model-path", (_event, filePath) => analyzeLocalModel(filePath));
  ipcMain.handle("desktop:start-model", (_event, selectionId, memoryLimitMb, qualityProfile) => {
    const selection = selections.get(selectionId);
    if (!selection || Date.now() - selection.createdAt > 30 * 60 * 1000) throw new Error("模型选择已过期，请重新选择文件");
    selections.delete(selectionId);
    return directJob(selection.filePath, resources, memoryLimitMb, qualityProfile);
  });
  ipcMain.handle("desktop:discard-selection", (_event, selectionId) => selections.delete(selectionId));
  ipcMain.handle("desktop:pick-existing-lod", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: "打开已处理的 LOD",
      buttonLabel: "直接流式预览",
      properties: ["openFile", "dontAddToRecent"],
      filters: [
        { name: "Gauss Stream LOD", extensions: ["json", "rad"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return openExistingAsset(result.filePaths[0]);
  });
  ipcMain.handle("desktop:open-existing-path", (_event, filePath) =>
    openExistingAsset(filePath),
  );
}

function createServer(resources) {
  const modelRoot = path.join(app.getPath("userData"), "models");
  fs.mkdirSync(modelRoot, { recursive: true });
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/examples/mobile-lod-viewer/") return serveFile(req, res, resources.viewer);
    if (url.pathname === "/dist/spark.module.js") return serveFile(req, res, resources.spark);
    if (url.pathname === "/examples/js/vendor/three/build/three.module.js") return serveFile(req, res, resources.three);
    if (url.pathname === "/examples/js/vendor/three/build/three.core.js") return serveFile(req, res, resources.threeCore);
    if (url.pathname === "/examples/js/vendor/three/examples/jsm/controls/OrbitControls.js") return serveFile(req, res, resources.orbitControls);
    if (testAssetRoot && url.pathname.startsWith("/test-assets/")) {
      let relative;
      try { relative = decodeURIComponent(url.pathname.slice("/test-assets/".length)); }
      catch { res.writeHead(400); res.end("Invalid path"); return; }
      const target = path.resolve(testAssetRoot, relative);
      if (target !== testAssetRoot && !target.startsWith(`${testAssetRoot}${path.sep}`)) { res.writeHead(403); res.end("Forbidden"); return; }
      return serveFile(req, res, target);
    }
    if (url.pathname === "/api/lod/system" && req.method === "GET") return sendJson(res, 200, systemSnapshot());
    if (url.pathname === "/api/lod/jobs" && req.method === "GET")
      return sendJson(res, 200, [...jobs.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(publicJob));

    if (url.pathname.startsWith("/local-assets/")) {
      let relative;
      try { relative = decodeURIComponent(url.pathname.slice("/local-assets/".length)); }
      catch { res.writeHead(400); res.end("Invalid path"); return; }
      const target = path.resolve(modelRoot, relative);
      if (target !== modelRoot && !target.startsWith(`${modelRoot}${path.sep}`)) { res.writeHead(403); res.end("Forbidden"); return; }
      return serveFile(req, res, target);
    }

    const assetMatch = /^\/job-assets\/([0-9a-f-]+)\/(.*)$/.exec(url.pathname);
    if (assetMatch) {
      const job = jobs.get(assetMatch[1]);
      if (!job?.assetRoot) { res.writeHead(404); res.end("Asset is not ready"); return; }
      let relative;
      try { relative = decodeURIComponent(assetMatch[2]); }
      catch { res.writeHead(400); res.end("Invalid path"); return; }
      const target = path.resolve(job.assetRoot, relative);
      if (target !== job.assetRoot && !target.startsWith(`${job.assetRoot}${path.sep}`)) { res.writeHead(403); res.end("Forbidden"); return; }
      return serveFile(req, res, target);
    }

    const importedMatch = /^\/import-assets\/([0-9a-f-]+)\/(.*)$/.exec(url.pathname);
    if (importedMatch) {
      const asset = importedAssets.get(importedMatch[1]);
      if (!asset) { res.writeHead(404); res.end("Imported asset is not mounted"); return; }
      let relative;
      try { relative = decodeURIComponent(importedMatch[2]); }
      catch { res.writeHead(400); res.end("Invalid path"); return; }
      const target = path.resolve(asset.root, relative);
      if (target !== asset.root && !target.startsWith(`${asset.root}${path.sep}`)) { res.writeHead(403); res.end("Forbidden"); return; }
      return serveFile(req, res, target);
    }

    if (url.pathname === "/api/lod/jobs" && req.method === "POST") {
      const name = safeName(String(req.headers["x-file-name"] || "model.ply"));
      const extension = path.extname(name).toLowerCase();
      if (!supportedExtensions.has(extension)) return sendJson(res, 415, { error: `外存模式暂不支持 ${extension || "未知"} 格式，请先转换为 PLY、SPZ 或 SPLAT` });
      const id = randomUUID();
      const jobDir = path.join(modelRoot, id);
      fs.mkdirSync(jobDir, { recursive: true });
      const inputPath = path.join(jobDir, name);
      const memoryLimitMb = clampMemoryLimit(req.headers["x-memory-limit-mb"]);
      const qualityProfile = clampQualityProfile(req.headers["x-quality-profile"]);
      const job = {
        id,
        name,
        bytes: Number(req.headers["content-length"] || 0),
        received: 0,
        state: "uploading",
        progress: 0,
        stage: "接收模型",
        memoryLimitMb,
        qualityProfile,
        log: [],
        outputDir: path.join(jobDir, "lod-output"),
        scratchDir: path.join(jobDir, "lod-scratch"),
        inputPath,
        createdAt: Date.now(),
        threads: 0,
      };
      jobs.set(id, job);
      const output = fs.createWriteStream(inputPath, { flags: "wx" });
      req.on("data", (chunk) => { job.received += chunk.length; if (job.bytes) job.progress = Math.min(15, job.received / job.bytes * 15); });
      req.on("aborted", () => { job.state = "cancelled"; output.destroy(); });
      output.on("error", (error) => { job.state = "error"; job.error = error.message; if (!res.headersSent) sendJson(res, 500, publicJob(job)); });
      output.on("finish", () => { job.progress = 16; sendJson(res, 202, publicJob(job)); enqueueJob(job); });
      req.pipe(output);
      return;
    }

    const match = /^\/api\/lod\/jobs\/([0-9a-f-]+)$/.exec(url.pathname);
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) return sendJson(res, 404, { error: "任务不存在" });
      if (req.method === "GET") return sendJson(res, 200, publicJob(job));
      if (req.method === "DELETE") {
        job.state = "cancelled"; job.stage = "已取消";
        terminateProcessTree(job.process);
        persistJobsSoon(); if (!job.process) setImmediate(pumpQueue);
        return sendJson(res, 200, publicJob(job));
      }
      if (req.method === "POST") {
        if (!["error", "cancelled", "interrupted"].includes(job.state))
          return sendJson(res, 409, { error: "只有失败、取消或已停止的任务可以重新构建" });
        if (!job.inputPath || !fs.existsSync(job.inputPath))
          return sendJson(res, 410, { error: "原模型文件已移动或删除，请重新选择模型" });
        job.error = undefined; job.completedAt = undefined; job.progress = 16;
        enqueueJob(job);
        return sendJson(res, 202, publicJob(job));
      }
    }
    res.writeHead(404); res.end("Not found");
  });
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32")
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGKILL");
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) app.quit();
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
});

app.whenReady().then(() => {
  if (!singleInstanceLock) return;
  const resources = resourcePaths();
  processorPath = resources.processor;
  jobsFile = path.join(app.getPath("userData"), "jobs.json");
  loadPersistedJobs();
  registerDesktopIpc(resources);
  server = createServer(resources);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1280,
      minHeight: 720,
      useContentSize: true,
      backgroundColor: "#080a0d",
      title: "Gauss Stream",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    mainWindow = window;
    window.on("closed", () => { mainWindow = undefined; });
    const viewerUrl = new URL(`http://127.0.0.1:${port}/examples/mobile-lod-viewer/`);
    if (testAssetRoot) viewerUrl.searchParams.set("asset", "/test-assets/manifest.json");
    window.loadURL(viewerUrl.href);
    if (process.env.GAUSS_CAPTURE_UI) {
      window.webContents.once("did-finish-load", () => {
        const delay = Math.max(1000, Number(process.env.GAUSS_CAPTURE_DELAY_MS) || 18000);
        setTimeout(async () => {
          try {
            window.setContentSize(1280, 720);
            if (process.env.GAUSS_CAPTURE_SETTINGS) {
              await window.webContents.executeJavaScript(
                'document.querySelector("#settings-toggle")?.click()',
              );
              await new Promise((resolve) => setTimeout(resolve, 350));
            }
            if (process.env.GAUSS_CAPTURE_ORBIT) {
              window.webContents.sendInputEvent({ type: "mouseDown", x: 520, y: 360, button: "left", clickCount: 1 });
              for (let x = 540; x <= 760; x += 20) {
                window.webContents.sendInputEvent({ type: "mouseMove", x, y: 330, movementX: 20, movementY: -3 });
              }
              window.webContents.sendInputEvent({ type: "mouseUp", x: 760, y: 330, button: "left", clickCount: 1 });
              await new Promise((resolve) => setTimeout(resolve, 900));
            }
            const image = await window.webContents.capturePage();
            fs.writeFileSync(path.resolve(process.env.GAUSS_CAPTURE_UI), image.toPNG());
          } catch (error) {
            console.error("Unable to capture minimum-window UI", error);
          } finally {
            app.quit();
          }
        }, delay);
      });
    }
    window.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  });
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  quitting = true;
  clearTimeout(persistTimer);
  for (const job of jobs.values()) {
    if (["processing", "queued", "uploading"].includes(job.state)) {
      job.state = "interrupted";
      job.stage = "程序退出，任务已停止";
      job.error = "任务因程序退出而停止";
    }
    terminateProcessTree(job.process);
  }
  try {
    const records = [...jobs.values()].map(({ process: _process, log: _log, assetRoot: _root, assetUrl: _url, ...job }) => job);
    fs.writeFileSync(jobsFile, JSON.stringify({ version: 1, jobs: records }, null, 2));
  } catch (error) { console.error("Unable to persist final job state", error); }
  server?.close();
});
