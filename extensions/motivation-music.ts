/**
 * Motivation Music Extension
 *
 * Plays motivational music while the model is thinking — but only for
 * Chinese-origin models (DeepSeek, MiMo, MiniMax, Kimi, Qwen, etc.).
 *
 * The music is streamed from YouTube (with mpv) or played from a local cache.
 * While playing, the volume ramps from quiet → 500% (extreme clipping),
 * and after 8s a bit-crusher worsens from 6-bit → 2-bit.
 * By the second loop the audio is completely destroyed.
 *
 * Usage:
 *   pi --motivation-music      # Enable (on by default)
 *   pi --no-motivation-music   # Disable
 *
 * While pi is running:
 *   /motivation-music               # Show status
 *   /motivation-music on|off        # Enable/disable
 *   /motivation-music cache         # Download audio for offline use
 *   /motivation-music url <url>     # Set custom YouTube URL
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_YOUTUBE_URL = "https://www.youtube.com/watch?v=rShjZ_op1V8";
const CACHE_DIR = join(tmpdir(), "pi-motivation-music");
const CACHE_FILE = join(CACHE_DIR, "music.opus");

// ─── Chinese-origin model detection ──────────────────────────────────────────

const CHINESE_PROVIDERS = new Set([
  "deepseek",
  "mimo",
  "minimax",
  "kimi",
  "moonshot",
  "qwen",
  "zhipu",
  "baichuan",
  "doubao",
  "bytedance",
  "stepfun",
  "yi",
  "lingyiwanwu",
]);

const CHINESE_MODEL_PATTERNS: RegExp[] = [
  /deepseek/i,
  /mimo/i,
  /minimax/i,
  /kimi/i,
  /moonshot/i,
  /qwen/i,
  /zhipu/i,
  /baichuan/i,
  /doubao/i,
  /bytedance/i,
  /stepfun/i,
  /yi-(large|vision|lightning|chat|coder)/i,
  /glm/i,
  /chatglm/i,
  /ernie/i,
  /hunyuan/i,
  /sense/i,
  /spark/i,
  /abab/i,
  /seed/i,
  /skywork/i,
  /internlm/i,
  /deepseek/i,
];

function isChineseOrigin(model: { provider: string; id: string } | null): boolean {
  if (!model) return false;
  const provider = model.provider.toLowerCase();
  const id = model.id.toLowerCase();
  if (CHINESE_PROVIDERS.has(provider)) return true;
  return CHINESE_MODEL_PATTERNS.some((p) => p.test(id));
}

// ─── Executable discovery ────────────────────────────────────────────────────

function which(bin: string): string | null {
  try {
    return execSync(`which ${bin}`, { stdio: "pipe", encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function findAnyPlayer(): { bin: string; args: (file: string) => string[] } | null {
  // mpv is the best: handles YouTube URLs and local files
  if (which("mpv")) {
    return {
      bin: "mpv",
      args: (file: string) => [
        "--no-video",
        "--loop=inf",
        "--really-quiet",
        "--volume=50",
        file,
      ],
    };
  }

  // ffplay (part of ffmpeg)
  if (which("ffplay")) {
    return {
      bin: "ffplay",
      args: (file: string) => [
        "-nodisp",
        "-loop",
        "0",
        "-autoexit",
        "-loglevel",
        "quiet",
        "-volume",
        "50",
        file,
      ],
    };
  }

  // VLC
  if (which("cvlc")) {
    return {
      bin: "cvlc",
      args: (file: string) => [
        "--no-video",
        "--loop",
        "--quiet",
        "--volume=128", // VLC uses 0-256
        file,
      ],
    };
  }

  return null;
}

function canStreamYoutube(): boolean {
  return which("mpv") !== null && which("yt-dlp") !== null;
}

// ─── Background download ─────────────────────────────────────────────────────

let downloadProcess: ChildProcess | null = null;

function startBackgroundDownload(url: string): void {
  if (downloadProcess) return; // already downloading
  if (!which("yt-dlp")) return; // can't download

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    return;
  }

  downloadProcess = spawn(
    "yt-dlp",
    [
      "-f",
      "bestaudio",
      "--extract-audio",
      "--audio-format",
      "opus",
      "-o",
      join(CACHE_DIR, "music.%(ext)s"),
      "--no-playlist",
      "--no-progress",
      url,
    ],
    { stdio: "ignore" },
  );

  downloadProcess.on("exit", (code) => {
    downloadProcess = null;
    // If download failed, clean up partial file
    if (code !== 0 && existsSync(CACHE_FILE)) {
      try { unlinkSync(CACHE_FILE); } catch {}
    }
  });

  downloadProcess.on("error", () => {
    downloadProcess = null;
  });
}

// ─── Music playback management ───────────────────────────────────────────────

let musicProcess: ChildProcess | null = null;
let musicKilledIntentionally = false;

function killMusic(): void {
  stopModulation();
  if (musicProcess && currentIpcSocket) {
    musicKilledIntentionally = true;
    // Quick fade-out: ramp volume to 0 over ~350ms
    const startVol = currentVolume;
    const fadeSteps = 7; // 50ms steps = 350ms total
    let step = 0;
    const fadeInterval = setInterval(() => {
      step++;
      const newVol = Math.round(startVol * (1 - step / fadeSteps));
      sendMpvCommand({ command: ["set_property", "volume", Math.max(newVol, 0)] });
      if (step >= fadeSteps) {
        clearInterval(fadeInterval);
        forceKillProcess();
      }
    }, 50);
    // Safety net: kill after 700ms no matter what
    setTimeout(() => {
      clearInterval(fadeInterval);
      forceKillProcess();
    }, 700);
    return;
  }
  forceKillProcess();
}

function forceKillProcess(): void {
  if (musicProcess) {
    try {
      const pid = musicProcess.pid;
      if (pid) {
        process.kill(-pid, "SIGTERM");
      }
    } catch {
      // Process already dead — fine
    }
    try {
      musicProcess.kill("SIGTERM");
    } catch {
      // Already dead
    }
    musicProcess = null;
  }
  cleanupIpcSocket();
}

function startMusic(url: string, ctx: ExtensionContext, isRetry = false): void {
  killMusic();

  // Only mpv supports real-time modulation via IPC
  if (which("mpv")) {
    startMpvWithModulation(url, ctx, isRetry);
    return;
  }

  // Strategy 2: play from cache without modulation
  fallbackToCached(url, ctx, isRetry);
}

// ─── MPV IPC-based modulation ────────────────────────────────────────────────

// Modulation timing — OBNOXIOUS settings
const VOLUME_START = 15;       // Start at 15% — a quiet murmur
const VOLUME_MAX = 500;        // Cap at 500% — way beyond clipping, pure noise
const VOLUME_STEP = 10;        // +10% each step
const VOLUME_RAMP_MS = 500;    // Ramp every 0.5 seconds — fast escalation
const DISTORTION_AFTER_MS = 8000;   // Second distortion layer kicks in after 8s
const DISTORTION_START_BITS = 6;    // Start at 6 bits — already aggressive
const DISTORTION_MIN_BITS = 2;      // End DESTROYED (2-bit)
const DISTORTION_STEP_MS = 3000;    // Worsen every 3s

let volumeRampTimer: ReturnType<typeof setInterval> | null = null;
let distortionTimer: ReturnType<typeof setTimeout> | null = null;
let distortionRampTimer: ReturnType<typeof setInterval> | null = null;
let currentIpcSocket: string | null = null;
let currentVolume = VOLUME_START;  // Tracked for fade-out

function sendMpvCommand(command: unknown): void {
  const sock = currentIpcSocket;
  if (!sock) return;
  try {
    const conn = createConnection(sock);
    conn.write(JSON.stringify(command) + "\n");
    conn.end();
  } catch {
    // Socket gone — mpv probably exited
  }
}

// Send multiple commands on a single connection (guarantees order)
function sendMpvCommands(commands: unknown[]): void {
  const sock = currentIpcSocket;
  if (!sock) return;
  try {
    const conn = createConnection(sock);
    for (const cmd of commands) {
      conn.write(JSON.stringify(cmd) + "\n");
    }
    conn.end();
  } catch {
    // Socket gone
  }
}

function startModulation(): void {
  stopModulation();

  currentVolume = VOLUME_START;
  sendMpvCommand({ command: ["set_property", "volume", currentVolume] });

  // Volume ramp: gradually get louder
  volumeRampTimer = setInterval(() => {
    currentVolume = Math.min(currentVolume + VOLUME_STEP, VOLUME_MAX);
    sendMpvCommand({ command: ["set_property", "volume", currentVolume] });
  }, VOLUME_RAMP_MS);

  // Distortion: after 8s, start worsening the crusher
  let crushBits = DISTORTION_START_BITS;
  distortionTimer = setTimeout(() => {
    // Replace startup filter with IPC-controlled one
    crushBits = DISTORTION_START_BITS;
    sendMpvCommands([
      { command: ["af", "remove", "@crush"] },
      { command: ["af", "add", `@crush:lavfi-acrusher=bits=${crushBits}:mode=log:aa=1`] },
    ]);

    // Worsen distortion every few seconds
    distortionRampTimer = setInterval(() => {
      if (crushBits <= DISTORTION_MIN_BITS) {
        if (distortionRampTimer) {
          clearInterval(distortionRampTimer);
          distortionRampTimer = null;
        }
        return;
      }
      crushBits = crushBits - 1;
      sendMpvCommands([
        { command: ["af", "remove", "@crush"] },
        { command: ["af", "add", `@crush:lavfi-acrusher=bits=${crushBits}:mode=log:aa=1`] },
      ]);
    }, DISTORTION_STEP_MS);
  }, DISTORTION_AFTER_MS);
}

function stopModulation(): void {
  if (volumeRampTimer) { clearInterval(volumeRampTimer); volumeRampTimer = null; }
  if (distortionTimer) { clearTimeout(distortionTimer); distortionTimer = null; }
  if (distortionRampTimer) { clearInterval(distortionRampTimer); distortionRampTimer = null; }
}

function cleanupIpcSocket(): void {
  const sock = currentIpcSocket;
  if (sock && existsSync(sock)) {
    try { unlinkSync(sock); } catch {}
  }
  currentIpcSocket = null;
}

function startMpvWithModulation(
  url: string,
  ctx: ExtensionContext,
  isRetry = false,
): void {
  // Generate unique IPC socket path (pid + timestamp)
  cleanupIpcSocket();
  currentIpcSocket = join(tmpdir(), `pi-motiv-ipc-${process.pid}-${Date.now()}.sock`);

  musicProcess = spawn(
    "mpv",
    [
      "--no-video",
      "--loop=inf",
      "--really-quiet",
      `--input-ipc-server=${currentIpcSocket}`,
      "--volume=15", // Start quiet; modulation takes over immediately
      // Pre-load aggressive distortion — guaranteed even if IPC fails
      "--af=@crush:lavfi-acrusher=bits=6:mode=log:aa=1",
      url,
    ],
    { stdio: "ignore", detached: false },
  );

  let started = false;
  musicKilledIntentionally = false;

  // Wait briefly for the IPC socket to appear, then begin modulation
  const waitForSocket = setInterval(() => {
    if (existsSync(currentIpcSocket!)) {
      clearInterval(waitForSocket);
      started = true;
      startModulation();
    }
  }, 100);

  // Safety: stop waiting after 10s
  setTimeout(() => {
    clearInterval(waitForSocket);
    if (!started) {
      // mpv might not support IPC; play without modulation
      ctx.ui.notify("Motivation music: IPC socket never appeared (modulation disabled)", "warning");
    }
  }, 10000);

  musicProcess.on("error", (err) => {
    clearInterval(waitForSocket);
    stopModulation();
    musicProcess = null;
    if (!isRetry) {
      fallbackToCached(url, ctx);
    } else {
      ctx.ui.notify(
        `Motivation music: couldn't play audio (${err.message})`,
        "warning",
      );
    }
  });

  musicProcess.on("exit", (code) => {
    clearInterval(waitForSocket);
    stopModulation();
    if (!musicKilledIntentionally && code !== 0 && code !== null && !isRetry) {
      musicProcess = null;
      cleanupIpcSocket();
      fallbackToCached(url, ctx);
    }
  });
}

// ─── Fallback playback (no modulation) ───────────────────────────────────────

function fallbackToCached(url: string, ctx: ExtensionContext, isRetry = false): void {
  if (existsSync(CACHE_FILE)) {
    const player = findAnyPlayer();
    if (player) {
      musicProcess = spawn(player.bin, player.args(CACHE_FILE), {
        stdio: "ignore",
        detached: false,
      });

      musicProcess.on("error", (err) => {
        musicProcess = null;
        ctx.ui.notify(
          `Motivation music: player error (${err.message})`,
          "warning",
        );
      });

      return;
    }

    ctx.ui.notify(
      "Motivation music: no audio player found. Install mpv, ffplay, or vlc.",
      "warning",
    );
    return;
  }

  // No cache file — try downloading for next time
  if (!isRetry) {
    startBackgroundDownload(url);
    ctx.ui.notify(
      "Motivation music: downloading audio for next time…",
      "info",
    );
  }
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── State ────────────────────────────────────────────────────────────────

  let enabled = true;
  let customUrl = DEFAULT_YOUTUBE_URL;
  let currentModel: { provider: string; id: string } | null = null;
  let cachePrimed = existsSync(CACHE_FILE);

  // ── Flags ────────────────────────────────────────────────────────────────

  pi.registerFlag("motivation-music", {
    description: "Play music while Chinese-origin models are thinking (default: on)",
    type: "boolean",
    default: true,
  });

  // ── Helper: check if we should play ──────────────────────────────────────

  function shouldPlay(): boolean {
    if (!enabled) return false;
    if (!isChineseOrigin(currentModel)) return false;
    return true;
  }

  // ── Events ───────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Read flag
    enabled = pi.getFlag("motivation-music") !== false;

    // Ensure cache directory exists
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
    } catch {}

    // Check if cache file is present
    cachePrimed = existsSync(CACHE_FILE);

    // Display status
    const player = findAnyPlayer();
    const statusParts: string[] = [];
    statusParts.push(enabled ? "enabled" : "disabled");
    statusParts.push(cachePrimed ? "cached" : "not cached");
    if (!player) statusParts.push("no player found");

    ctx.ui.setStatus(
      "motivation",
      ctx.ui.theme.fg(
        enabled && player ? "success" : "dim",
        `🎵 motivation: ${statusParts.join(", ")}`,
      ),
    );
  });

  pi.on("model_select", async (event, _ctx) => {
    currentModel = event.model;
  });

  pi.on("agent_start", async (_event, ctx) => {
    // Fallback: if model_select hasn't fired yet (e.g., initial startup),
    // grab the current model from ctx
    if (!currentModel && ctx.model) {
      currentModel = ctx.model as { provider: string; id: string };
    }

    if (!shouldPlay()) return;

    // Check if we have any way to play audio
    if (!canStreamYoutube() && !cachePrimed && !which("yt-dlp")) {
      ctx.ui.notify(
        "Motivation music: install mpv or yt-dlp+ffplay (or vlc)",
        "warning",
      );
      return;
    }

    startMusic(customUrl, ctx);

    // Kick off background download for future if not cached
    if (!cachePrimed && !downloadProcess) {
      startBackgroundDownload(customUrl);
    }
  });

  pi.on("agent_end", async (_event, _ctx) => {
    killMusic();
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    killMusic();
    cleanupIpcSocket();
    if (downloadProcess) {
      try { downloadProcess.kill("SIGTERM"); } catch {}
      downloadProcess = null;
    }
  });

  // ── Command ──────────────────────────────────────────────────────────────

  pi.registerCommand("motivation-music", {
    description: "Toggle motivation music or show status",

    getArgumentCompletions: (_prefix: string) => {
      return [
        { value: "on", label: "on — Enable" },
        { value: "off", label: "off — Disable" },
        { value: "status", label: "status — Show current state" },
        { value: "cache", label: "cache — Download audio for offline use" },
        { value: "url", label: "url <youtube-url> — Set custom music URL" },
      ];
    },

    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();

      if (sub === "on" || sub === "enable") {
        enabled = true;
        killMusic();
        ctx.ui.notify("Motivation music: enabled 🎵", "info");
        ctx.ui.setStatus(
          "motivation",
          ctx.ui.theme.fg("success", `🎵 motivation: enabled, ${cachePrimed ? "cached" : "not cached"}`),
        );
        return;
      }

      if (sub === "off" || sub === "disable") {
        enabled = false;
        killMusic();
        ctx.ui.notify("Motivation music: disabled 🔇", "info");
        ctx.ui.setStatus(
          "motivation",
          ctx.ui.theme.fg("dim", "🎵 motivation: disabled"),
        );
        return;
      }

      if (sub.startsWith("url")) {
        const newUrl = args.slice(3).trim();
        if (!newUrl) {
          ctx.ui.notify(
            `Current URL: ${customUrl}\nUsage: /motivation-music url <youtube-url>`,
            "info",
          );
          return;
        }
        customUrl = newUrl;
        // Invalidate cache for new URL
        if (existsSync(CACHE_FILE)) {
          try { unlinkSync(CACHE_FILE); } catch {}
        }
        cachePrimed = false;
        if (downloadProcess) {
          try { downloadProcess.kill("SIGTERM"); } catch {}
          downloadProcess = null;
        }
        ctx.ui.notify(`Motivation music: URL updated. Cache cleared.`);
        return;
      }

      if (sub === "cache") {
        if (cachePrimed) {
          ctx.ui.notify(
            "Motivation music: audio already cached ✓",
            "info",
          );
          return;
        }

        if (!which("yt-dlp")) {
          ctx.ui.notify(
            "Motivation music: yt-dlp not installed. Install it to cache audio.",
            "error",
          );
          return;
        }

        ctx.ui.notify("Downloading motivation music…", "info");
        startBackgroundDownload(customUrl);

        // Poll for completion
        let attempts = 0;
        const checkInterval = setInterval(() => {
          attempts++;
          if (existsSync(CACHE_FILE)) {
            clearInterval(checkInterval);
            cachePrimed = true;
            ctx.ui.notify("Motivation music: cached ✓", "info");
            ctx.ui.setStatus(
              "motivation",
              ctx.ui.theme.fg(
                enabled ? "success" : "dim",
                `🎵 motivation: ${enabled ? "enabled" : "disabled"}, cached`,
              ),
            );
          } else if (!downloadProcess && attempts > 1) {
            clearInterval(checkInterval);
            ctx.ui.notify(
              "Motivation music: download failed. Check yt-dlp output.",
              "error",
            );
          }
        }, 1000);
        return;
      }

      // Default: show status
      const player = findAnyPlayer();
      const lines = [
        `Status:       ${enabled ? "enabled 🎵" : "disabled 🔇"}`,
        `Audio cached: ${cachePrimed ? "yes ✓" : "no"}`,
        `Player found: ${player ? `yes (${player.bin})` : "no — install mpv, ffplay, or vlc"}`,
        `Can stream:   ${canStreamYoutube() ? "yes (mpv + yt-dlp)" : "no"}`,
        `Current model: ${currentModel ? `${currentModel.provider}/${currentModel.id}` : "none"}`,
        `Chinese model: ${isChineseOrigin(currentModel) ? "yes" : "no"}`,
        `Would play:   ${shouldPlay() ? "yes" : "no"}`,
        `URL:          ${customUrl}`,
      ];

      for (const line of lines) {
        ctx.ui.notify(line, "info");
      }
    },
  });
}
