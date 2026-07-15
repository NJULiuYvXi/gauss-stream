import {
  type ChildProcessWithoutNullStreams,
  spawn,
  spawnSync,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite";

type JobState =
  | "uploading"
  | "queued"
  | "processing"
  | "ready"
  | "error"
  | "cancelled";

type LodJob = {
  id: string;
  name: string;
  bytes: number;
  received: number;
  state: JobState;
  progress: number;
  stage: string;
  memoryLimitMb: number;
  qualityProfile: "original" | "high" | "compact";
  createdAt: number;
  assetUrl?: string;
  error?: string;
  log: string[];
  process?: ChildProcessWithoutNullStreams;
};

const SUPPORTED_EXTENSIONS = new Set([".ply", ".spz", ".splat"]);
const processorQualitySupport = new Map<string, boolean>();

function supportsStreamQuality(binary: string) {
  if (binary === "cargo") return true;
  const cached = processorQualitySupport.get(binary);
  if (cached !== undefined) return cached;
  const probe = spawnSync(binary, [], { windowsHide: true, encoding: "utf8" });
  const supported = `${probe.stdout || ""}\n${probe.stderr || ""}`.includes(
    "--stream-quality",
  );
  processorQualitySupport.set(binary, supported);
  return supported;
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

function publicJob(job: LodJob) {
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
    log: job.log.slice(-8),
  };
}

function systemSnapshot() {
  const totalMemoryMb = Math.floor(os.totalmem() / 1048576);
  const freeMemoryMb = Math.floor(os.freemem() / 1048576);
  return {
    totalMemoryMb,
    freeMemoryMb,
    maxMemoryMb: Math.max(
      512,
      Math.min(32768, Math.floor((totalMemoryMb * 0.75) / 256) * 256),
    ),
    cpuCount: os.availableParallelism?.() || os.cpus().length,
    cpuModel: os.cpus()[0]?.model || "Unknown CPU",
    platform: process.platform,
  };
}

function clampMemoryLimit(value: string | string[] | undefined) {
  const maximum = systemSnapshot().maxMemoryMb;
  const numeric = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isFinite(numeric)) return Math.min(4096, maximum);
  return Math.max(512, Math.min(maximum, Math.round(numeric / 256) * 256));
}

function clampQualityProfile(
  value: string | string[] | undefined,
): "original" | "high" | "compact" {
  const profile = Array.isArray(value) ? value[0] : value;
  return profile === "high" || profile === "compact" ? profile : "original";
}

function safeName(value: string) {
  const decoded = decodeURIComponent(value || "model.ply");
  return (
    path
      .basename(decoded)
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .slice(0, 180) || "model.ply"
  );
}

function updateProgress(job: LodJob, line: string) {
  const text = line.trim();
  if (!text) return;
  job.log.push(text);
  if (job.log.length > 40) job.log.shift();

  if (/Decod|Loading|Reading|Processing:/i.test(text)) {
    job.stage = "解析高斯数据";
    job.progress = Math.max(job.progress, 22);
  } else if (/bhatt_lod|Level:|Sorted and prepared/i.test(text)) {
    job.stage = "构建 Bhatt LOD 层级";
    job.progress = Math.max(job.progress, 42);
  } else if (/chunk_tree|Chunk/i.test(text)) {
    job.stage = "空间分块与索引";
    job.progress = Math.max(job.progress, 72);
  } else if (/Encoding RAD|Comment:/i.test(text)) {
    job.stage = "编码流式 RAD";
    job.progress = Math.max(job.progress, 86);
  } else if (/Wrote .*\.rad/i.test(text)) {
    job.stage = "完成";
    job.progress = 99;
  }
  if (/STREAM_PHASE decode/.test(text)) {
    job.stage = "流式解码并写入磁盘";
    job.progress = Math.max(job.progress, 18);
  } else if (/STREAM_PHASE bucket/.test(text)) {
    job.stage = "空间分桶（内存有界）";
    job.progress = Math.max(job.progress, 35);
  } else if (/STREAM_PHASE lod/.test(text)) {
    job.stage = "逐桶构建 Bhatt LOD";
    job.progress = Math.max(job.progress, 48);
  } else if (/STREAM_TILE_DONE (\d+) (\d+)/.test(text)) {
    const match = /STREAM_TILE_DONE (\d+) (\d+)/.exec(text);
    if (match) {
      job.progress = Math.max(
        job.progress,
        48 + (Number(match[1]) / Number(match[2])) * 46,
      );
    }
  } else if (/STREAM_PHASE manifest/.test(text)) {
    job.stage = "生成流式场景清单";
    job.progress = Math.max(job.progress, 96);
  }
}

export function lodProcessingApi(options: { assetRoot: string }): Plugin {
  const jobs = new Map<string, LodJob>();
  const assetRoot = path.resolve(options.assetRoot);
  const repoRoot = path.resolve(".");

  function startJob(job: LodJob, inputPath: string) {
    const releaseBinary = path.join(
      repoRoot,
      "rust",
      "target",
      "release",
      process.platform === "win32" ? "build-lod.exe" : "build-lod",
    );
    const customBinary = process.env.SPARK_LOD_BIN;
    const binary =
      customBinary || (fs.existsSync(releaseBinary) ? releaseBinary : "cargo");
    const supportsQuality = supportsStreamQuality(binary);
    if (!supportsQuality && job.qualityProfile !== "compact") {
      job.state = "error";
      job.stage = "原画质处理器尚未编译";
      job.error =
        "当前 release build-lod 仍是旧版，只能生成紧凑量化 RAD；请重新编译新版处理器后再构建原画质数据。";
      return;
    }
    const qualityArgs = supportsQuality
      ? [`--stream-quality=${job.qualityProfile}`]
      : [];
    const args =
      binary === "cargo"
        ? [
            "run",
            "--manifest-path",
            path.join(repoRoot, "rust", "build-lod", "Cargo.toml"),
            "--release",
            "--",
            "--streaming",
            `--memory-limit-mb=${job.memoryLimitMb}`,
            ...qualityArgs,
            inputPath,
          ]
        : [
            "--streaming",
            `--memory-limit-mb=${job.memoryLimitMb}`,
            ...qualityArgs,
            inputPath,
          ];

    job.state = "processing";
    job.stage = customBinary
      ? "使用外部流式 LOD 处理器"
      : `启动 ${(job.memoryLimitMb / 1024).toFixed(job.memoryLimitMb % 1024 ? 1 : 0)} GB Bhatt LOD 处理器`;
    job.progress = 18;
    const child = spawn(binary, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.process = child;

    const consume = (data: Buffer) => {
      for (const line of data.toString("utf8").split(/\r?\n/))
        updateProgress(job, line);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", (error) => {
      job.state = "error";
      job.stage = "处理器启动失败";
      job.error = error.message;
    });
    child.on("close", (code) => {
      job.process = undefined;
      if (job.state === "cancelled") return;
      const stem = inputPath.slice(0, -path.extname(inputPath).length);
      const manifestPath = path.join(`${stem}-lod-stream`, "manifest.json");
      if (code === 0 && fs.existsSync(manifestPath)) {
        job.state = "ready";
        job.stage = "可开始流式预览";
        job.progress = 100;
        job.assetUrl = `/local-assets/${job.id}/${encodeURIComponent(path.basename(stem))}-lod-stream/manifest.json`;
      } else {
        job.state = "error";
        job.stage = "LOD 处理失败";
        job.error = job.log.at(-1) || `处理器退出码 ${code ?? "unknown"}`;
      }
    });
  }

  return {
    name: "spark-lod-processing-api",
    configureServer(server) {
      fs.mkdirSync(assetRoot, { recursive: true });

      server.middlewares.use(
        (req: IncomingMessage, res: ServerResponse, next) => {
          const url = new URL(req.url || "/", "http://localhost");
          if (url.pathname === "/api/lod/system" && req.method === "GET") {
            json(res, 200, systemSnapshot());
            return;
          }
          if (url.pathname === "/api/lod/jobs" && req.method === "POST") {
            const name = safeName(
              String(req.headers["x-file-name"] || "model.ply"),
            );
            const extension = path.extname(name).toLowerCase();
            if (!SUPPORTED_EXTENSIONS.has(extension)) {
              json(res, 415, { error: `不支持 ${extension || "未知"} 格式` });
              return;
            }

            const bytes = Number(req.headers["content-length"] || 0);
            const id = randomUUID();
            const jobDir = path.join(assetRoot, id);
            fs.mkdirSync(jobDir, { recursive: true });
            const inputPath = path.join(jobDir, name);
            const job: LodJob = {
              id,
              name,
              bytes,
              received: 0,
              state: "uploading",
              progress: 0,
              stage: "接收模型",
              memoryLimitMb: clampMemoryLimit(req.headers["x-memory-limit-mb"]),
              qualityProfile: clampQualityProfile(
                req.headers["x-quality-profile"],
              ),
              createdAt: Date.now(),
              log: [],
            };
            jobs.set(id, job);

            const output = fs.createWriteStream(inputPath, { flags: "wx" });
            req.on("data", (chunk: Buffer) => {
              job.received += chunk.length;
              if (job.bytes > 0)
                job.progress = Math.min(15, (job.received / job.bytes) * 15);
            });
            req.on("aborted", () => {
              job.state = "cancelled";
              output.destroy();
              fs.rmSync(jobDir, { recursive: true, force: true });
            });
            output.on("error", (error) => {
              job.state = "error";
              job.error = error.message;
              if (!res.headersSent) json(res, 500, publicJob(job));
            });
            output.on("finish", () => {
              if (job.state === "cancelled") return;
              job.state = "queued";
              job.stage = "上传完成，等待处理";
              job.progress = 16;
              json(res, 202, publicJob(job));
              startJob(job, inputPath);
            });
            req.pipe(output);
            return;
          }

          const match = /^\/api\/lod\/jobs\/([0-9a-f-]+)$/.exec(url.pathname);
          if (!match) return next();
          const job = jobs.get(match[1]);
          if (!job) {
            json(res, 404, { error: "任务不存在或服务已重启" });
            return;
          }
          if (req.method === "GET") {
            json(res, 200, publicJob(job));
            return;
          }
          if (req.method === "DELETE") {
            job.state = "cancelled";
            job.stage = "已取消";
            job.process?.kill();
            json(res, 200, publicJob(job));
            return;
          }
          next();
        },
      );
    },
  };
}
