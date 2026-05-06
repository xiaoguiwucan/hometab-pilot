import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { Client as SshClient } from "ssh2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const publicConfigPath = path.join(distDir, "config.json");
const sourceConfigPath = path.join(rootDir, "public", "config.json");
const dataDir = process.env.DATA_DIR || path.join(rootDir, "data");
const bookmarksPath = path.join(dataDir, "bookmarks.json");
const runtimeConfigPath = path.join(dataDir, "config.json");
const connectionsPath = path.join(dataDir, "connections.json");
const authPath = path.join(dataDir, "auth.json");
const sessionsPath = path.join(dataDir, "sessions.json");
const notificationPath = path.join(dataDir, "notifications.json");
const notificationHistoryPath = path.join(dataDir, "notification-history.json");
const auditPath = path.join(dataDir, "audit-log.json");
const containerBackupDir = path.join(dataDir, "container-backups");
const backupDir = path.join(dataDir, "backups");
const backupSettingsPath = path.join(dataDir, "backup-settings.json");
const port = Number(process.env.PORT || 8080);
const appVersion = "0.4.0";
const operationCooldowns = new Map();
const undoWindows = new Map();

const app = express();
app.use(express.json({ limit: "1mb" }));

if (process.env.PVE_TLS_VERIFY === "false") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function hostnameOf(value) {
  try {
    return new URL(normalizeUrl(value)).hostname;
  } catch {
    return "";
  }
}

function logoCandidates(url, logoUrl) {
  const normalized = normalizeUrl(url);
  const candidates = [];
  if (logoUrl) candidates.push(logoUrl);

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname;
    const isLocalHost = host.endsWith(".local") || host.endsWith(".lan") || !host.includes(".");
    if (!isLocalHost) {
      candidates.push(`${parsed.origin}/favicon.ico`);
      candidates.push(`${parsed.origin}/apple-touch-icon.png`);
      candidates.push(`${parsed.origin}/apple-touch-icon-precomposed.png`);
    }
    candidates.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`);
    candidates.push(`https://icons.duckduckgo.com/ip3/${host}.ico`);
  } catch {
    // Invalid URLs are rejected by callers.
  }

  return [...new Set(candidates.filter(Boolean))];
}

async function getConfig() {
  const fallback = await readJson(sourceConfigPath, {
    categories: [],
    bookmarks: [],
    bookmarkOrder: [],
    folders: [],
    recent: [],
    favorites: [],
    systems: {}
  });
  return readJson(runtimeConfigPath, await readJson(publicConfigPath, fallback));
}

async function getBookmarks() {
  return readJson(bookmarksPath, []);
}

function backupFileName(date = new Date()) {
  return `hometab-${date.toISOString().replace(/[:.]/g, "-")}.json`;
}

function isSafeBackupName(name) {
  return /^hometab-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(String(name || ""));
}

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) return false;
  const candidate = hashPassword(password, record.salt).hash;
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(record.hash, "hex"));
}

async function getAuthConfig() {
  return readJson(authPath, {});
}

async function getSessions() {
  const sessions = await readJson(sessionsPath, []);
  const now = Date.now();
  return sessions.filter((session) => new Date(session.expiresAt).getTime() > now);
}

async function writeSessions(sessions) {
  await writeJson(sessionsPath, sessions);
}

function authTokenFrom(request) {
  const header = String(request.headers.authorization || "");
  if (header.startsWith("Bearer ")) return header.slice(7);
  return String(request.headers["x-hometab-token"] || request.query.token || "");
}

async function currentSession(request) {
  const token = authTokenFrom(request);
  if (!token) return null;
  const sessions = await getSessions();
  return sessions.find((session) => session.token === token) || null;
}

async function authStatus(request) {
  const auth = await getAuthConfig();
  const configured = Boolean(auth.hash && auth.salt);
  return {
    configured,
    required: configured,
    authenticated: configured ? Boolean(await currentSession(request)) : true
  };
}

async function requireAuth(request, response) {
  const status = await authStatus(request);
  if (!status.required || status.authenticated) return true;
  response.status(401).json({ error: "Authentication required" });
  return false;
}

async function requirePassword(request, response) {
  if (!(await requireAuth(request, response))) return false;
  const auth = await getAuthConfig();
  if (!auth.hash || !auth.salt) return true;
  if (verifyPassword(request.body?.password || "", auth)) return true;
  await appendAudit({ actor: request.ip, action: "auth.password.required.failed", target: "auth", detail: "二次密码校验失败", severity: "warn", result: "failed" });
  response.status(403).json({ error: "Password confirmation required" });
  return false;
}

async function appendAudit(entry) {
  const current = await readJson(auditPath, []);
  const next = [{
    id: `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    ts: Date.now(),
    at: nowIso(),
    actor: entry.actor || "system",
    result: entry.result || "success",
    ...entry
  }, ...current].slice(0, 300);
  await writeJson(auditPath, next);
  return next[0];
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function auditEventsToCsv(events) {
  const headers = ["at", "actor", "source", "action", "target", "severity", "result", "detail", "error"];
  const rows = events.map((event) => headers.map((key) => csvEscape(event[key])).join(","));
  return [headers.join(","), ...rows].join("\n");
}

function cooldownKey(scope, id, action) {
  return `${scope}:${id}:${action}`;
}

function checkCooldown(scope, id, action, seconds = 30) {
  const key = cooldownKey(scope, id, action);
  const until = operationCooldowns.get(key) || 0;
  if (until > Date.now()) {
    return { ok: false, retryAfter: Math.ceil((until - Date.now()) / 1000), until: new Date(until).toISOString() };
  }
  operationCooldowns.set(key, Date.now() + seconds * 1000);
  return { ok: true, retryAfter: 0, until: new Date(Date.now() + seconds * 1000).toISOString() };
}

function undoToken() {
  return crypto.randomBytes(18).toString("hex");
}

async function getNotificationSettings() {
  const stored = await readJson(notificationPath, {});
  return {
    enabled: stored.enabled ?? process.env.NOTIFY_ENABLED === "true",
    barkUrl: stored.barkUrl || process.env.BARK_URL || "",
    serverChanKey: stored.serverChanKey || process.env.SERVER_CHAN_KEY || "",
    telegramBotToken: stored.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: stored.telegramChatId || process.env.TELEGRAM_CHAT_ID || "",
    webhookUrl: stored.webhookUrl || process.env.NOTIFY_WEBHOOK_URL || "",
    wecomWebhookUrl: stored.wecomWebhookUrl || process.env.WECOM_WEBHOOK_URL || "",
    quietMinutes: Number(stored.quietMinutes ?? process.env.NOTIFY_QUIET_MINUTES ?? 15),
    dailySummaryEnabled: Boolean(stored.dailySummaryEnabled ?? false),
    dailySummaryHour: Number(stored.dailySummaryHour ?? process.env.NOTIFY_DAILY_SUMMARY_HOUR ?? 9),
    lastDailySummaryDate: stored.lastDailySummaryDate || ""
  };
}

function publicNotificationSettings(settings) {
  return {
    enabled: Boolean(settings.enabled),
    barkConfigured: Boolean(settings.barkUrl),
    serverChanConfigured: Boolean(settings.serverChanKey),
    telegramConfigured: Boolean(settings.telegramBotToken && settings.telegramChatId),
    webhookConfigured: Boolean(settings.webhookUrl),
    wecomConfigured: Boolean(settings.wecomWebhookUrl),
    quietMinutes: Number(settings.quietMinutes || 0),
    dailySummaryEnabled: Boolean(settings.dailySummaryEnabled),
    dailySummaryHour: Number(settings.dailySummaryHour || 9),
    lastDailySummaryDate: settings.lastDailySummaryDate || ""
  };
}

async function shouldSendNotification(key, quietMinutes) {
  if (!key || !quietMinutes) return true;
  const history = await readJson(notificationHistoryPath, {});
  const last = new Date(history[key] || 0).getTime();
  if (last && Date.now() - last < quietMinutes * 60 * 1000) return false;
  await writeJson(notificationHistoryPath, { ...history, [key]: nowIso() });
  return true;
}

async function sendNotification(title, message, severity = "info", key = "") {
  const settings = await getNotificationSettings();
  if (!settings.enabled) return { ok: false, skipped: "disabled" };
  if (!(await shouldSendNotification(key || `${severity}:${title}`, settings.quietMinutes))) {
    return { ok: false, skipped: "quiet-window" };
  }
  const tasks = [];
  if (settings.barkUrl) {
    const url = `${String(settings.barkUrl).replace(/\/$/, "")}/${encodeURIComponent(title)}/${encodeURIComponent(message)}?group=HomeTab&level=${severity === "critical" ? "critical" : "active"}`;
    tasks.push(fetch(url).then((res) => ({ channel: "bark", ok: res.ok, status: res.status })));
  }
  if (settings.serverChanKey) {
    tasks.push(fetch(`https://sctapi.ftqq.com/${settings.serverChanKey}.send`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title, desp: message })
    }).then((res) => ({ channel: "serverChan", ok: res.ok, status: res.status })));
  }
  if (settings.telegramBotToken && settings.telegramChatId) {
    tasks.push(fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: settings.telegramChatId, text: `${title}\n${message}` })
    }).then((res) => ({ channel: "telegram", ok: res.ok, status: res.status })));
  }
  if (settings.webhookUrl) {
    tasks.push(fetch(settings.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, message, severity, source: "HomeTab Pilot", at: nowIso() })
    }).then((res) => ({ channel: "webhook", ok: res.ok, status: res.status })));
  }
  if (settings.wecomWebhookUrl) {
    tasks.push(fetch(settings.wecomWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: {
          content: `**${title}**\n\n${message}\n\n> HomeTab Pilot · ${severity} · ${nowIso()}`
        }
      })
    }).then((res) => ({ channel: "wecom", ok: res.ok, status: res.status })));
  }
  const results = await Promise.allSettled(tasks);
  const normalized = results.map((item) => item.status === "fulfilled" ? item.value : { channel: "unknown", ok: false, error: item.reason?.message || String(item.reason) });
  return { ok: normalized.some((item) => item.ok), results: normalized };
}

async function maybeSendDailySummary(status) {
  const settings = await getNotificationSettings();
  if (!settings.enabled || !settings.dailySummaryEnabled) return;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (settings.lastDailySummaryDate === today || now.getHours() < settings.dailySummaryHour) return;
  const docker = status.docker || {};
  const pve = status.pve || {};
  const fnos = status.fnos || {};
  const message = [
    `FNOS：${fnos.available ? "在线" : "异常"} CPU ${fnos.cpu ?? "-"}% / 内存 ${fnos.memory ?? "-"}%`,
    `Docker：${docker.running ?? 0}/${docker.total ?? 0} 个容器运行`,
    `PVE：${pve.available ? `${pve.node || "node"} 在线` : "异常"}，${pve.vms?.length || 0} 台 VM/LXC`
  ].join("\n");
  await sendNotification("HomeTab Pilot 每日摘要", message, "info", `daily-summary:${today}`);
  const current = await getNotificationSettings();
  await writeJson(notificationPath, { ...current, lastDailySummaryDate: today });
}

async function buildBackupPayload() {
  const [config, customBookmarks] = await Promise.all([getConfig(), getBookmarks()]);
  return {
    version: appVersion,
    exportedAt: new Date().toISOString(),
    source: "manual",
    config,
    customBookmarks
  };
}

async function getBackupSettings() {
  const stored = await readJson(backupSettingsPath, {});
  return {
    enabled: Boolean(stored.enabled),
    intervalHours: Math.max(1, Math.min(Number(stored.intervalHours || 24), 168)),
    keep: Math.max(3, Math.min(Number(stored.keep || 14), 60)),
    lastRunAt: stored.lastRunAt || "",
    note: stored.note || ""
  };
}

async function pruneBackups(keep) {
  const settings = keep ? { keep } : await getBackupSettings();
  try {
    const entries = await fs.readdir(backupDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isSafeBackupName(entry.name))
        .map(async (entry) => {
          const filePath = path.join(backupDir, entry.name);
          const stat = await fs.stat(filePath);
          return { name: entry.name, mtimeMs: stat.mtimeMs };
        })
    );
    await Promise.all(
      files
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(settings.keep)
        .map((file) => fs.rm(path.join(backupDir, file.name), { force: true }))
    );
  } catch {
    // Missing backup directory is created on the first snapshot.
  }
}

async function createBackupSnapshot(payload, meta = {}) {
  await fs.mkdir(backupDir, { recursive: true });
  const backup = payload || (await buildBackupPayload());
  backup.version = backup.version || appVersion;
  backup.source = meta.source || backup.source || "manual";
  backup.note = meta.note ?? backup.note ?? "";
  backup.createdBy = meta.createdBy || backup.createdBy || "system";
  const name = backupFileName(new Date(backup.exportedAt || Date.now()));
  await writeJson(path.join(backupDir, name), backup);
  await pruneBackups();
  return { name, ...summarizeBackup(name, backup) };
}

function summarizeBackup(name, payload) {
  return {
    name,
    exportedAt: payload.exportedAt,
    version: payload.version || 1,
    source: payload.source || "manual",
    note: payload.note || "",
    configBookmarks: Array.isArray(payload.config?.bookmarks) ? payload.config.bookmarks.length : 0,
    customBookmarks: Array.isArray(payload.customBookmarks) ? payload.customBookmarks.length : 0,
    categories: Array.isArray(payload.config?.categories) ? payload.config.categories.length : 0
  };
}

async function listBackupSnapshots() {
  try {
    const entries = await fs.readdir(backupDir, { withFileTypes: true });
    const backups = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isSafeBackupName(entry.name))
        .map(async (entry) => {
          const payload = await readJson(path.join(backupDir, entry.name), {});
          const stat = await fs.stat(path.join(backupDir, entry.name));
          return { ...summarizeBackup(entry.name, payload), size: stat.size, mtimeMs: stat.mtimeMs };
        })
    );
    return backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

function backupDiff(current, candidate) {
  const currentBookmarks = new Set([...(current.config?.bookmarks || []), ...(current.customBookmarks || [])].map((item) => normalizeUrl(item.url)));
  const candidateBookmarks = new Set([...(candidate.config?.bookmarks || []), ...(candidate.customBookmarks || [])].map((item) => normalizeUrl(item.url)));
  const added = [...candidateBookmarks].filter((url) => !currentBookmarks.has(url));
  const removed = [...currentBookmarks].filter((url) => !candidateBookmarks.has(url));
  const categoryChanges = {
    current: current.config?.categories || [],
    backup: candidate.config?.categories || []
  };
  return {
    addedBookmarks: added,
    removedBookmarks: removed,
    currentCount: currentBookmarks.size,
    backupCount: candidateBookmarks.size,
    categoryChanges
  };
}

async function createBackupArchive() {
  const backups = await listBackupSnapshots();
  const payloads = await Promise.all(backups.map(async (backup) => ({
    summary: backup,
    payload: await readJson(path.join(backupDir, backup.name), {})
  })));
  const bundle = { version: appVersion, exportedAt: nowIso(), backups: payloads };
  return zlib.gzipSync(Buffer.from(JSON.stringify(bundle, null, 2)));
}

async function maybeRunScheduledBackup() {
  const settings = await getBackupSettings();
  if (!settings.enabled) return null;
  const last = settings.lastRunAt ? new Date(settings.lastRunAt).getTime() : 0;
  if (last && Date.now() - last < settings.intervalHours * 60 * 60 * 1000) return null;
  const backup = await createBackupSnapshot({ ...(await buildBackupPayload()), exportedAt: nowIso() }, { source: "scheduled", note: settings.note, createdBy: "scheduler" });
  await writeJson(backupSettingsPath, { ...settings, lastRunAt: nowIso() });
  return backup;
}

async function getConnections() {
  const stored = await readJson(connectionsPath, {});
  return {
    fnos: {
      url: stored.fnos?.url || process.env.FNOS_URL || "",
      sshHost: stored.fnos?.sshHost || process.env.FNOS_SSH_HOST || "",
      sshPort: Number(stored.fnos?.sshPort || process.env.FNOS_SSH_PORT || 22),
      sshUsername: stored.fnos?.sshUsername || process.env.FNOS_SSH_USERNAME || "",
      sshPassword: stored.fnos?.sshPassword || process.env.FNOS_SSH_PASSWORD || ""
    },
    pve: {
      url: stored.pve?.url || process.env.PVE_URL || "",
      username: stored.pve?.username || process.env.PVE_USERNAME || "",
      password: stored.pve?.password || process.env.PVE_PASSWORD || "",
      tokenId: stored.pve?.tokenId || process.env.PVE_TOKEN_ID || "",
      tokenSecret: stored.pve?.tokenSecret || process.env.PVE_TOKEN_SECRET || "",
      tlsVerify: stored.pve?.tlsVerify ?? process.env.PVE_TLS_VERIFY !== "false"
    }
  };
}

function pveBaseUrl(connection) {
  return (connection.url || "").split("#")[0].replace(/\/$/, "");
}

function pveHeaders(connection) {
  if (!connection.tokenId || !connection.tokenSecret) return null;
  return {
    Authorization: `PVEAPIToken=${connection.tokenId}=${connection.tokenSecret}`
  };
}

async function pveFetch(pathname, init = {}) {
  const connection = (await getConnections()).pve;
  if (!connection.tlsVerify) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const base = pveBaseUrl(connection);
  if (!base) throw new Error("PVE_URL is not configured");
  let headers = pveHeaders(connection);
  let csrfToken = "";

  if (!headers) {
    const ticket = await pveLogin(connection);
    headers = { Cookie: `PVEAuthCookie=${ticket.ticket}` };
    csrfToken = ticket.csrf;
  }

  const response = await fetch(`${base}/api2/json${pathname}`, {
    ...init,
    signal: init.signal || AbortSignal.timeout(5000),
    headers: {
      ...headers,
      ...(csrfToken && init.method && init.method !== "GET" ? { CSRFPreventionToken: csrfToken } : {}),
      ...(init.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`PVE request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  return payload.data;
}

async function pveLogin(connection) {
  if (!connection.username || !connection.password) {
    throw new Error("PVE token or username/password is not configured");
  }

  const base = pveBaseUrl(connection);
  const username = connection.username.includes("@") ? connection.username : `${connection.username}@pam`;
  const body = new URLSearchParams({
    username,
    password: connection.password
  });
  const response = await fetch(`${base}/api2/json/access/ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(5000),
    body
  });

  if (!response.ok) {
    throw new Error(`PVE login failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  return {
    ticket: payload.data.ticket,
    csrf: payload.data.CSRFPreventionToken
  };
}

async function getPveStatus() {
  try {
    const nodes = await pveFetch("/nodes");
    const firstNodeData = nodes[0] || {};
    const firstNode = firstNodeData.node;
    const memory = firstNodeData.maxmem ? Math.round((Number(firstNodeData.mem || 0) / Number(firstNodeData.maxmem)) * 100) : 0;
    const storage = firstNodeData.maxdisk ? Math.round((Number(firstNodeData.disk || 0) / Number(firstNodeData.maxdisk)) * 100) : 0;
    const cpu = Math.round(Number(firstNodeData.cpu || 0) * 100);
    const [qemu, lxc] = firstNode
      ? await Promise.all([
          pveFetch(`/nodes/${encodeURIComponent(firstNode)}/qemu`).catch(() => []),
          pveFetch(`/nodes/${encodeURIComponent(firstNode)}/lxc`).catch(() => [])
        ])
      : [[], []];

    return {
      available: true,
      node: firstNode || "unknown",
      cpu: Number.isFinite(cpu) ? Math.max(0, Math.min(100, cpu)) : 0,
      memory: Number.isFinite(memory) ? Math.max(0, Math.min(100, memory)) : 0,
      storage: Number.isFinite(storage) ? Math.max(0, Math.min(100, storage)) : 0,
      nodes,
      vms: [...qemu, ...lxc].map((vm) => ({
        vmid: vm.vmid,
        name: vm.name,
        status: vm.status,
        type: vm.type || (qemu.includes(vm) ? "qemu" : "lxc"),
        node: firstNode || "",
        cpu: vm.cpu,
        mem: vm.mem,
        maxmem: vm.maxmem
      }))
    };
  } catch (error) {
    return {
      available: false,
      node: "",
      cpu: 0,
      memory: 0,
      storage: 0,
      nodes: [],
      vms: [],
      error: error.message
    };
  }
}

async function getFnosStatus(config) {
  const connection = (await getConnections()).fnos;
  const url = connection.url || "";
  const fallback = {
    storage: config.systems?.fnos?.storage || 0,
    cpu: config.systems?.fnos?.cpu || 0,
    memory: config.systems?.fnos?.memory || 0
  };
  if (!url) {
    return {
      available: false,
      status: config.systems?.fnos?.status || "未配置",
      ...fallback
    };
  }

  const sshStatus = await getFnosSshStatus(url, connection).catch((error) => ({ error: error.message }));
  const sshHost = connection.sshHost || hostnameOf(url);

  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(3000)
    });
    return {
      available: response.ok,
      status: sshStatus.available ? "SSH 已连接" : response.ok ? "已连接" : `HTTP ${response.status}`,
      storage: sshStatus.storage ?? fallback.storage,
      cpu: sshStatus.cpu ?? fallback.cpu,
      memory: sshStatus.memory ?? fallback.memory,
      url,
      httpAvailable: response.ok,
      sshAvailable: Boolean(sshStatus.available),
      sshHost,
      error: sshStatus.error
    };
  } catch (error) {
    return {
      available: Boolean(sshStatus.available),
      status: sshStatus.available ? "SSH 已连接" : "连接失败",
      storage: sshStatus.storage ?? fallback.storage,
      cpu: sshStatus.cpu ?? fallback.cpu,
      memory: sshStatus.memory ?? fallback.memory,
      error: sshStatus.error || error.message,
      url,
      httpAvailable: false,
      sshAvailable: Boolean(sshStatus.available),
      sshHost
    };
  }
}

function getFnosSshStatus(url, connection) {
  if (!connection.sshHost && !connection.sshUsername) {
    return Promise.resolve({});
  }

  const parsed = new URL(url);
  const host = connection.sshHost || parsed.hostname;
  const port = Number(connection.sshPort || 22);
  const username = connection.sshUsername;
  const password = connection.sshPassword;
  if (!host || !username || !password) return Promise.resolve({});

  const command = [
    "CPU=$(awk 'NR==1{idle=$5; total=0; for(i=2;i<=NF;i++) total+=$i; print int((total-idle)*100/total)}' /proc/stat)",
    "MEM=$(free | awk '/Mem:/ {print int($3*100/$2)}')",
    "DISK=$(df -P / | awk 'NR==2 {gsub(/%/,\"\",$5); print $5}')",
    "echo \"$CPU $MEM $DISK\""
  ].join("; ");

  return new Promise((resolve) => {
    const client = new SshClient();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      client.end();
      resolve(value);
    };

    client
      .on("ready", () => {
        client.exec(command, (error, stream) => {
          if (error) {
            finish({ error: error.message });
            return;
          }
          let output = "";
          let stderr = "";
          stream
            .on("data", (data) => {
              output += data.toString();
            })
            .stderr.on("data", (data) => {
              stderr += data.toString();
            });
          stream.on("close", () => {
            const [cpu, memory, storage] = output.trim().split(/\s+/).map(Number);
            if ([cpu, memory, storage].some((value) => Number.isNaN(value))) {
              finish({ error: stderr || "FNOS SSH metrics parse failed" });
              return;
            }
            finish({ available: true, cpu, memory, storage });
          });
        });
      })
      .on("error", (error) => finish({ error: error.message }))
      .connect({
        host,
        port,
        username,
        password,
        readyTimeout: 4000
      });
  });
}

async function runFnosSsh(command) {
  const connection = (await getConnections()).fnos;
  const url = connection.url || "http://localhost";
  const parsed = new URL(url);
  const host = connection.sshHost || parsed.hostname;
  const port = Number(connection.sshPort || 22);
  const username = connection.sshUsername;
  const password = connection.sshPassword;

  if (!host || !username || !password) {
    throw new Error("FNOS SSH is not configured");
  }

  return new Promise((resolve, reject) => {
    const client = new SshClient();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      client.end();
      if (error) reject(error);
      else resolve(value);
    };

    client
      .on("ready", () => {
        client.exec(command, (error, stream) => {
          if (error) {
            finish(error);
            return;
          }
          let stdout = "";
          let stderr = "";
          stream
            .on("data", (data) => {
              stdout += data.toString();
            })
            .stderr.on("data", (data) => {
              stderr += data.toString();
            });
          stream.on("close", (code) => {
            if (code && stderr) {
              finish(new Error(stderr.trim()));
              return;
            }
            finish(null, stdout);
          });
        });
      })
      .on("error", (error) => finish(error))
      .connect({
        host,
        port,
        username,
        password,
        readyTimeout: 5000
      });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function runFnosDocker(args) {
  const connection = (await getConnections()).fnos;
  const sudoPrefix = connection.sshPassword ? `printf %s ${shellQuote(connection.sshPassword)} | sudo -S -p '' ` : "";
  return runFnosSsh(`${sudoPrefix}docker ${args}`);
}

function parseJsonLines(output) {
  return output
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function dockerAccessUrls(inspect, connection) {
  const host = connection.sshHost || hostnameOf(connection.url);
  const ports = inspect?.NetworkSettings?.Ports || {};
  const urls = Object.entries(ports)
    .flatMap(([containerPort, bindings]) =>
      (bindings || []).map((binding) => ({
        label: containerPort,
        url: `http://${host}:${binding.HostPort}`,
        hostPort: binding.HostPort
      }))
    )
    .filter((item) => item.hostPort);
  return [...new Map(urls.map((item) => [item.url, item])).values()];
}

function dockerBookmarkName(name) {
  const presets = {
    clouddrive2: "CloudDrive2",
    mdc: "MDC",
    "new-api": "New API",
    db_online: "DB Online",
    "byte-muse": "Byte Muse",
    flaresolverr: "FlareSolverr",
    immortal: "Immortal"
  };
  if (presets[name]) return presets[name];
  return String(name || "container")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

async function checkWebAccess(url) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(1600)
    });
    const latencyMs = Date.now() - startedAt;
    return {
      webStatus: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "ok",
      httpStatus: response.status,
      latencyMs,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      webStatus: "error",
      httpStatus: 0,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      error: error.name === "TimeoutError" ? "timeout" : error.message
    };
  }
}

async function withWebAccessChecks(services) {
  const checks = new Map();
  await Promise.all(
    services.flatMap((service) =>
      (service.accessUrls || []).slice(0, 3).map(async (access) => {
        checks.set(access.url, await checkWebAccess(access.url));
      })
    )
  );
  return services.map((service) => ({
    ...service,
    accessUrls: (service.accessUrls || []).map((access) => ({
      ...access,
      ...(checks.get(access.url) || {})
    }))
  }));
}

function redactEnv(env = []) {
  const secretPattern = /(PASS|PASSWORD|TOKEN|SECRET|KEY|AUTH|COOKIE|CREDENTIAL)/i;
  return env.map((item) => {
    const [key, ...rest] = String(item).split("=");
    if (secretPattern.test(key)) return `${key}=******`;
    return `${key}=${rest.join("=")}`;
  });
}

function slimInspect(inspect, connection) {
  if (!inspect) return {};
  return {
    id: inspect.Id,
    name: String(inspect.Name || "").replace(/^\//, ""),
    image: inspect.Config?.Image || inspect.Image,
    created: inspect.Created,
    command: [inspect.Path, ...(inspect.Args || [])].filter(Boolean).join(" "),
    workingDir: inspect.Config?.WorkingDir || "",
    restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || "",
    ports: inspect.NetworkSettings?.Ports || {},
    accessUrls: dockerAccessUrls(inspect, connection),
    mounts: (inspect.Mounts || []).map((mount) => ({
      type: mount.Type,
      source: mount.Source,
      destination: mount.Destination,
      mode: mount.Mode
    })),
    env: redactEnv(inspect.Config?.Env || []),
    labels: inspect.Config?.Labels || {},
    health: inspect.State?.Health?.Status || ""
  };
}

async function getDockerStatus() {
  try {
    const connection = (await getConnections()).fnos;
    const psOutput = await runFnosDocker("ps -a --format '{{json .}}'");
    const rows = parseJsonLines(psOutput);
    const statsRows = await runFnosDocker("stats --no-stream --format '{{json .}}'").then(parseJsonLines).catch(() => []);
    const statsByName = new Map(statsRows.map((row) => [row.Name, row]));
    const inspectOutput = rows.length ? await runFnosDocker(`inspect ${rows.map((row) => shellQuote(row.ID)).join(" ")}`) : "[]";
    const inspectRows = JSON.parse(inspectOutput);
    const inspectByShortId = new Map(inspectRows.map((row) => [String(row.Id).slice(0, 12), row]));

    const services = rows
      .map((container) => {
        const inspect = inspectByShortId.get(container.ID);
        const stats = statsByName.get(container.Names) || {};
        const detail = slimInspect(inspect, connection);
        return {
        id: container.ID,
        name: container.Names,
        image: container.Image,
        state: String(container.State || "").toLowerCase(),
        status: container.Status,
        cpu: stats.CPUPerc || "",
        memory: stats.MemPerc || "",
        memoryUsage: stats.MemUsage || "",
        network: stats.NetIO || "",
        block: stats.BlockIO || "",
        pids: stats.PIDs || "",
        accessUrls: detail.accessUrls || [],
        portsText: container.Ports || "",
        health: detail.health || "",
        ports: detail.ports || {},
        restartPolicy: detail.restartPolicy || ""
        };
      });
    const servicesWithWebChecks = await withWebAccessChecks(services);

    return {
      available: true,
      source: "fnos-ssh",
      running: servicesWithWebChecks.filter((container) => container.state === "running").length,
      total: servicesWithWebChecks.length,
      services: servicesWithWebChecks
    };
  } catch (error) {
    return {
      available: false,
      source: "fnos-ssh",
      running: 0,
      total: 0,
      services: [],
      error: error.message
    };
  }
}

async function getDockerContainerDetail(id) {
  const connection = (await getConnections()).fnos;
  const inspectOutput = await runFnosDocker(`inspect ${shellQuote(id)}`);
  const inspect = JSON.parse(inspectOutput)[0];
  const stats = await runFnosDocker(`stats --no-stream --format '{{json .}}' ${shellQuote(id)}`)
    .then(parseJsonLines)
    .then((rows) => rows[0] || {})
    .catch(() => ({}));
  return {
    ...slimInspect(inspect, connection),
    accessUrls: await Promise.all(
      (slimInspect(inspect, connection).accessUrls || []).map(async (access) => ({
        ...access,
        ...(await checkWebAccess(access.url))
      }))
    ),
    state: inspect.State,
    stats: {
      cpu: stats.CPUPerc || "",
      memory: stats.MemPerc || "",
      memoryUsage: stats.MemUsage || "",
      network: stats.NetIO || "",
      block: stats.BlockIO || "",
      pids: stats.PIDs || ""
    }
  };
}

function safeContainerName(value) {
  return String(value || "").replace(/^\//, "").replace(/[^a-zA-Z0-9_.-]/g, "_") || "container";
}

async function saveContainerBackup(id, reason = "manual") {
  const inspectOutput = await runFnosDocker(`inspect ${shellQuote(id)}`);
  const inspect = JSON.parse(inspectOutput)[0];
  const name = safeContainerName(inspect.Name || id);
  const payload = { version: 1, reason, exportedAt: nowIso(), inspect };
  await fs.mkdir(containerBackupDir, { recursive: true });
  const filename = `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeJson(path.join(containerBackupDir, filename), payload);
  return { filename, payload };
}

function dockerRunArgsFromInspect(inspect) {
  const args = ["run", "-d", "--name", shellQuote(safeContainerName(inspect.Name))];
  const hostConfig = inspect.HostConfig || {};
  const config = inspect.Config || {};
  if (hostConfig.Privileged) args.push("--privileged");
  if (hostConfig.RestartPolicy?.Name) args.push("--restart", shellQuote(hostConfig.RestartPolicy.Name));
  for (const dns of hostConfig.Dns || []) args.push("--dns", shellQuote(dns));
  for (const [containerPort, bindings] of Object.entries(inspect.NetworkSettings?.Ports || {})) {
    for (const binding of bindings || []) {
      args.push("-p", shellQuote(`${binding.HostIp && binding.HostIp !== "0.0.0.0" ? `${binding.HostIp}:` : ""}${binding.HostPort}:${containerPort}`));
    }
  }
  for (const mount of inspect.Mounts || []) {
    if (mount.Type === "bind") {
      const suffix = mount.Mode ? `:${mount.Mode}` : "";
      args.push("-v", shellQuote(`${mount.Source}:${mount.Destination}${suffix}`));
    }
  }
  for (const env of config.Env || []) args.push("-e", shellQuote(env));
  const networks = Object.keys(inspect.NetworkSettings?.Networks || {}).filter((item) => item !== "bridge");
  if (networks[0]) args.push("--network", shellQuote(networks[0]));
  args.push(shellQuote(config.Image || inspect.Config?.Image || inspect.Image));
  if (Array.isArray(config.Cmd)) args.push(...config.Cmd.map(shellQuote));
  return args.join(" ");
}

function dockerRecreateSafety(inspect) {
  const hostConfig = inspect.HostConfig || {};
  const config = inspect.Config || {};
  const networkMode = String(hostConfig.NetworkMode || "");
  const risks = [];
  if (hostConfig.Privileged) risks.push("privileged");
  if ((hostConfig.Devices || []).length) risks.push("devices");
  if ((hostConfig.CapAdd || []).length) risks.push("cap_add");
  if ((hostConfig.Binds || []).some((bind) => String(bind).includes(":shared") || String(bind).includes(":rshared"))) risks.push("shared_mount");
  if (networkMode === "host" || networkMode === "container") risks.push(`${networkMode}_network`);
  if (hostConfig.IpcMode && hostConfig.IpcMode !== "private") risks.push("ipc_mode");
  if (hostConfig.PidMode) risks.push("pid_mode");
  if (config.Entrypoint && Array.isArray(config.Entrypoint) && config.Entrypoint.length) risks.push("entrypoint");
  return {
    safe: risks.length === 0,
    risks,
    summary: {
      name: safeContainerName(inspect.Name),
      image: config.Image || inspect.Image || "",
      imageId: inspect.Image || "",
      command: [inspect.Path, ...(inspect.Args || [])].filter(Boolean).join(" "),
      mounts: (inspect.Mounts || []).map((mount) => ({ type: mount.Type, source: mount.Source, destination: mount.Destination, mode: mount.Mode })),
      ports: inspect.NetworkSettings?.Ports || {},
      env: redactEnv(config.Env || []),
      restartPolicy: hostConfig.RestartPolicy?.Name || "",
      networkMode,
      runCommand: dockerRunArgsFromInspect(inspect)
    }
  };
}

async function inspectContainer(id) {
  const inspectOutput = await runFnosDocker(`inspect ${shellQuote(id)}`);
  return JSON.parse(inspectOutput)[0];
}

function digestFromRepoDigests(repoDigests = []) {
  const value = Array.isArray(repoDigests) ? repoDigests[0] : "";
  return String(value || "").includes("@") ? String(value).split("@").pop() : "";
}

async function dockerImageDigestReport(image) {
  const localRaw = image ? await runFnosDocker(`image inspect ${shellQuote(image)} --format '{{json .}}'`).catch(() => "") : "";
  const local = localRaw ? JSON.parse(localRaw) : {};
  const manifestRaw = image ? await runFnosDocker(`manifest inspect ${shellQuote(image)}`).catch(() => "") : "";
  const manifest = manifestRaw ? JSON.parse(manifestRaw) : {};
  const localDigest = digestFromRepoDigests(local.RepoDigests) || local.Id || "";
  const remoteDigest = manifest?.Descriptor?.digest || manifest?.digest || manifest?.config?.digest || "";
  return {
    localDigest,
    remoteDigest,
    hasUpdate: Boolean(localDigest && remoteDigest && localDigest !== remoteDigest),
    repoDigests: local.RepoDigests || []
  };
}

async function containerUpdateReport(id) {
  const inspect = await inspectContainer(id);
  const detail = dockerRecreateSafety(inspect);
  const image = inspect.Config?.Image || "";
  const digest = await dockerImageDigestReport(image);
  return {
    ok: true,
    id,
    image,
    ...digest,
    safety: detail,
    backups: await listContainerBackups(safeContainerName(inspect.Name || id))
  };
}

async function listContainerBackups(id = "") {
  try {
    const entries = await fs.readdir(containerBackupDir, { withFileTypes: true });
    const backups = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map(async (entry) => {
      const filePath = path.join(containerBackupDir, entry.name);
      const payload = await readJson(filePath, {});
      const stat = await fs.stat(filePath);
      return {
        name: entry.name,
        exportedAt: payload.exportedAt,
        reason: payload.reason,
        container: safeContainerName(payload.inspect?.Name || ""),
        image: payload.inspect?.Config?.Image || "",
        mtimeMs: stat.mtimeMs
      };
    }));
    return backups
      .filter((backup) => !id || backup.container === safeContainerName(id))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 20);
  } catch {
    return [];
  }
}

function diagnosticItem(id, label, ok, detail, level = "error") {
  return {
    id,
    label,
    status: ok ? "ok" : level,
    detail
  };
}

function buildDiagnostics(status) {
  const fnos = status.fnos || {};
  const pve = status.pve || {};
  const docker = status.docker || {};
  const fnosHttpDetail = fnos.httpAvailable
    ? `HTTP 正常：${fnos.url || "FNOS"}`
    : fnos.available
      ? "Web 未响应，但 SSH 可用"
      : fnos.error || "FNOS Web 未连通";
  const fnosSshDetail = fnos.sshAvailable
    ? `SSH 正常：${fnos.sshHost || "默认主机"}`
    : fnos.error || "SSH 未配置或不可用";

  return [
    diagnosticItem("fnos-http", "FNOS Web", Boolean(fnos.httpAvailable), fnosHttpDetail, fnos.available ? "warn" : "error"),
    diagnosticItem("fnos-ssh", "FNOS SSH", Boolean(fnos.sshAvailable), fnosSshDetail),
    diagnosticItem(
      "docker",
      "Docker",
      Boolean(docker.available),
      docker.available ? `${docker.running}/${docker.total} 个容器，来源 ${docker.source || "fnos-ssh"}` : docker.error || "Docker 不可用"
    ),
    diagnosticItem(
      "pve",
      "PVE API",
      Boolean(pve.available),
      pve.available ? `${pve.node || "node"} 在线，${pve.vms?.length || 0} 台 VM/LXC` : pve.error || "PVE API 不可用"
    )
  ];
}

app.get("/api/runtime", async (_request, response) => {
  await maybeRunScheduledBackup();
  const config = await getConfig();
  const [customBookmarks, dockerStatus, pveStatus, fnosStatus] = await Promise.all([
    getBookmarks(),
    getDockerStatus(),
    getPveStatus(),
    getFnosStatus(config)
  ]);

  const status = {
    docker: dockerStatus,
    pve: pveStatus,
    fnos: fnosStatus
  };
  void maybeSendDailySummary(status).catch(() => undefined);

  response.json({
    config,
    customBookmarks,
    generatedAt: new Date().toISOString(),
    diagnostics: buildDiagnostics(status),
    status
  });
});

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/auth/status", async (request, response) => {
  response.json(await authStatus(request));
});

app.post("/api/auth/setup", async (request, response) => {
  const current = await getAuthConfig();
  if (current.hash && current.salt && !(await requireAuth(request, response))) return;
  const password = String(request.body?.password || "");
  if (password.length < 6) {
    response.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }
  await writeJson(authPath, { ...hashPassword(password), createdAt: nowIso() });
  await appendAudit({ actor: "setup", action: "auth.setup", target: "auth", detail: "管理密码已设置", severity: "info" });
  response.json({ ok: true });
});

app.post("/api/auth/login", async (request, response) => {
  const auth = await getAuthConfig();
  if (!auth.hash || !auth.salt) {
    response.status(400).json({ error: "Password is not configured" });
    return;
  }
  if (!verifyPassword(request.body?.password || "", auth)) {
    await appendAudit({ actor: request.ip, action: "auth.login.failed", target: "auth", detail: "登录失败", severity: "warn" });
    response.status(401).json({ error: "Invalid password" });
    return;
  }
  const token = crypto.randomBytes(32).toString("hex");
  const session = { token, createdAt: nowIso(), expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString(), actor: request.ip };
  await writeSessions([session, ...(await getSessions())].slice(0, 10));
  await appendAudit({ actor: request.ip, action: "auth.login", target: "auth", detail: "登录成功", severity: "info" });
  response.json({ ok: true, token, expiresAt: session.expiresAt });
});

app.post("/api/auth/logout", async (request, response) => {
  const token = authTokenFrom(request);
  await writeSessions((await getSessions()).filter((session) => session.token !== token));
  response.json({ ok: true });
});

app.get("/api/audit", async (request, response) => {
  if (!(await requireAuth(request, response))) return;
  response.json({ events: await readJson(auditPath, []) });
});

app.get("/api/audit/export", async (request, response) => {
  if (!(await requireAuth(request, response))) return;
  response.type("application/json").send(JSON.stringify(await readJson(auditPath, []), null, 2));
});

app.get("/api/audit/export.csv", async (request, response) => {
  if (!(await requireAuth(request, response))) return;
  response.type("text/csv").send(auditEventsToCsv(await readJson(auditPath, [])));
});

app.get("/api/notifications", async (request, response) => {
  if (!(await requireAuth(request, response))) return;
  response.json(publicNotificationSettings(await getNotificationSettings()));
});

app.put("/api/notifications", async (request, response) => {
  if (!(await requireAuth(request, response))) return;
  const current = await getNotificationSettings();
  const next = {
    enabled: Boolean(request.body?.enabled),
    barkUrl: request.body?.barkUrl ? String(request.body.barkUrl) : current.barkUrl,
    serverChanKey: request.body?.serverChanKey ? String(request.body.serverChanKey) : current.serverChanKey,
    telegramBotToken: request.body?.telegramBotToken ? String(request.body.telegramBotToken) : current.telegramBotToken,
    telegramChatId: request.body?.telegramChatId ? String(request.body.telegramChatId) : current.telegramChatId,
    webhookUrl: request.body?.webhookUrl ? String(request.body.webhookUrl) : current.webhookUrl,
    wecomWebhookUrl: request.body?.wecomWebhookUrl ? String(request.body.wecomWebhookUrl) : current.wecomWebhookUrl,
    quietMinutes: Math.max(0, Math.min(Number(request.body?.quietMinutes ?? current.quietMinutes ?? 15), 1440)),
    dailySummaryEnabled: Boolean(request.body?.dailySummaryEnabled),
    dailySummaryHour: Math.max(0, Math.min(Number(request.body?.dailySummaryHour ?? current.dailySummaryHour ?? 9), 23)),
    lastDailySummaryDate: current.lastDailySummaryDate || ""
  };
  await writeJson(notificationPath, next);
  await appendAudit({ actor: "admin", action: "notifications.update", target: "notifications", detail: "通知配置已更新", severity: "info" });
  response.json(publicNotificationSettings(next));
});

app.post("/api/notifications/test", async (request, response) => {
  if (!(await requireAuth(request, response))) return;
  const result = await sendNotification("HomeTab Pilot 测试通知", "通知通道已连通。", "info", `test:${Date.now()}`);
  response.json(result);
});

app.post("/api/notifications/event", async (request, response) => {
  const title = String(request.body?.title || "HomeTab Pilot 告警");
  const message = String(request.body?.message || request.body?.detail || "");
  const severity = String(request.body?.severity || "warn");
  const key = String(request.body?.key || `${severity}:${title}:${message}`);
  const result = await sendNotification(title, message, severity, key);
  response.json(result);
});

app.post("/api/notifications/daily-summary", async (request, response) => {
  if (!(await requireAuth(request, response))) return;
  const status = {
    docker: await getDockerStatus(),
    pve: await getPveStatus(),
    fnos: await getFnosStatus(await getConfig())
  };
  const docker = status.docker || {};
  const pve = status.pve || {};
  const fnos = status.fnos || {};
  const message = [
    `FNOS：${fnos.available ? "在线" : "异常"} CPU ${fnos.cpu ?? "-"}% / 内存 ${fnos.memory ?? "-"}%`,
    `Docker：${docker.running ?? 0}/${docker.total ?? 0} 个容器运行`,
    `PVE：${pve.available ? `${pve.node || "node"} 在线` : "异常"}，${pve.vms?.length || 0} 台 VM/LXC`
  ].join("\n");
  response.json(await sendNotification("HomeTab Pilot 每日摘要", message, "info", `manual-daily:${Date.now()}`));
});

app.get("/api/bookmarks", async (_request, response) => {
  response.json(await getBookmarks());
});

app.post("/api/bookmarks", async (request, response) => {
  const url = normalizeUrl(request.body?.url);
  const host = hostnameOf(url);
  if (!url || !host) {
    response.status(400).json({ error: "Valid url is required" });
    return;
  }

  const current = await getBookmarks();
  const name = String(request.body?.name || host.replace(/^www\./, "").split(".")[0]).trim();
  const bookmark = {
    name,
    url,
    category: String(request.body?.category || "常用"),
    icon: name.slice(0, 1).toUpperCase(),
    color: "light",
    logoUrl: request.body?.logoUrl || logoCandidates(url)[0]
  };
  const next = [bookmark, ...current.filter((item) => item.url !== url)].slice(0, 80);
  await writeJson(bookmarksPath, next);
  response.status(201).json(bookmark);
});

app.put("/api/bookmarks", async (request, response) => {
  const bookmarks = Array.isArray(request.body?.bookmarks) ? request.body.bookmarks : null;
  if (!bookmarks) {
    response.status(400).json({ error: "Bookmarks array is required" });
    return;
  }

  const normalized = bookmarks
    .map((item) => {
      const url = normalizeUrl(item?.url);
      const host = hostnameOf(url);
      const name = String(item?.name || host.replace(/^www\./, "").split(".")[0] || "Bookmark").trim();
      if (!url || !host) return null;
      return {
        name,
        url,
        category: String(item?.category || "常用"),
        icon: String(item?.icon || name.slice(0, 1).toUpperCase()),
        color: String(item?.color || "light"),
        logoUrl: item?.logoUrl || logoCandidates(url)[0]
      };
    })
    .filter(Boolean)
    .slice(0, 80);

  await writeJson(bookmarksPath, normalized);
  response.json({ ok: true, bookmarks: normalized });
});

app.post("/api/bookmarks/sync-web-containers", async (request, response) => {
  const category = String(request.body?.category || "NAS").trim() || "NAS";
  const dockerStatus = await getDockerStatus();
  if (!dockerStatus.available) {
    response.status(503).json({ error: dockerStatus.error || "Docker is not available" });
    return;
  }

  const config = await getConfig();
  const currentBookmarks = await getBookmarks();
  const defaultUrls = new Set((config.bookmarks || []).map((bookmark) => normalizeUrl(bookmark.url)));
  const colors = ["cyan", "teal", "violet", "sage", "blue", "rose", "amber", "green"];
  const webBookmarks = dockerStatus.services
    .filter((service) => service.state === "running" && service.accessUrls?.length)
    .map((service, index) => {
      const access = service.accessUrls[0];
      const displayName = dockerBookmarkName(service.name);
      return {
        name: displayName || service.name,
        url: access.url,
        category,
        icon: (displayName || service.name || "C").slice(0, 1).toUpperCase(),
        color: colors[index % colors.length],
        logoUrl: "",
        status: access.webStatus === "error" ? "warning" : "online"
      };
    })
    .filter((bookmark) => bookmark.url && !defaultUrls.has(normalizeUrl(bookmark.url)));

  const syncedUrls = new Set(webBookmarks.map((bookmark) => normalizeUrl(bookmark.url)));
  const nextBookmarks = [
    ...webBookmarks,
    ...currentBookmarks.filter((bookmark) => !syncedUrls.has(normalizeUrl(bookmark.url)))
  ].slice(0, 80);
  const orderUrls = new Set();
  const bookmarkOrder = [
    ...webBookmarks.map((bookmark) => bookmark.url),
    ...(config.bookmarkOrder || []),
    ...(config.bookmarks || []).filter((bookmark) => bookmark.name !== "添加").map((bookmark) => bookmark.url)
  ].filter((url) => {
    const key = normalizeUrl(url);
    if (!key || orderUrls.has(key)) return false;
    orderUrls.add(key);
    return true;
  });
  const nextConfig = {
    ...config,
    categories: config.categories?.includes(category) ? config.categories : [...(config.categories || []), category],
    bookmarkOrder
  };

  await createBackupSnapshot({ version: 1, exportedAt: new Date().toISOString(), config, customBookmarks: currentBookmarks });
  await Promise.all([writeJson(bookmarksPath, nextBookmarks), writeJson(runtimeConfigPath, nextConfig)]);
  response.json({
    ok: true,
    category,
    synced: webBookmarks.length,
    bookmarks: nextBookmarks,
    config: nextConfig,
    items: webBookmarks,
    checkedAt: new Date().toISOString()
  });
});

app.delete("/api/bookmarks", async (request, response) => {
  const url = normalizeUrl(request.body?.url || request.query.url);
  if (!url) {
    response.status(400).json({ error: "Url is required" });
    return;
  }

  const current = await getBookmarks();
  const next = current.filter((item) => item.url !== url);
  await writeJson(bookmarksPath, next);
  response.json({ ok: true, bookmarks: next });
});

app.delete("/api/bookmarks/all", async (_request, response) => {
  await writeJson(bookmarksPath, []);
  response.json({ ok: true, bookmarks: [] });
});

app.put("/api/config", async (request, response) => {
  const current = await getConfig();
  const next = {
    ...current,
    categories: Array.isArray(request.body?.categories) ? request.body.categories : current.categories,
    bookmarks: Array.isArray(request.body?.bookmarks) ? request.body.bookmarks : current.bookmarks,
    bookmarkOrder: Array.isArray(request.body?.bookmarkOrder) ? request.body.bookmarkOrder : current.bookmarkOrder,
    folders: Array.isArray(request.body?.folders) ? request.body.folders : current.folders,
    recent: Array.isArray(request.body?.recent) ? request.body.recent : current.recent,
    favorites: Array.isArray(request.body?.favorites) ? request.body.favorites : current.favorites,
    systems: request.body?.systems && typeof request.body.systems === "object" ? request.body.systems : current.systems
  };
  await writeJson(runtimeConfigPath, next);
  response.json(next);
});

app.post("/api/config/reset", async (_request, response) => {
  try {
    await fs.rm(runtimeConfigPath, { force: true });
  } catch {
    // Missing config is already reset.
  }
  response.json(await getConfig());
});

app.get("/api/backup", async (_request, response) => {
  const backup = await buildBackupPayload();
  await createBackupSnapshot(backup, { source: "manual", note: "导出备份" });
  response.json(backup);
});

app.post("/api/backup", async (request, response) => {
  const config = request.body?.config;
  const customBookmarks = request.body?.customBookmarks;

  if (!config || typeof config !== "object" || !Array.isArray(customBookmarks)) {
    response.status(400).json({ error: "Backup must include config and customBookmarks" });
    return;
  }

  const nextBookmarks = customBookmarks.slice(0, 80);
  await Promise.all([writeJson(runtimeConfigPath, config), writeJson(bookmarksPath, nextBookmarks)]);
  await createBackupSnapshot({
    version: request.body?.version || appVersion,
    exportedAt: new Date().toISOString(),
    source: request.body?.source || "import",
    note: request.body?.note || "导入恢复",
    config,
    customBookmarks: nextBookmarks
  });
  response.json({ ok: true, config, customBookmarks: nextBookmarks });
});

app.get("/api/backups", async (_request, response) => {
  response.json({ backups: await listBackupSnapshots() });
});

app.post("/api/backups", async (request, response) => {
  response.json({ ok: true, backup: await createBackupSnapshot(await buildBackupPayload(), { source: request.body?.source || "manual", note: request.body?.note || "", createdBy: "user" }) });
});

app.get("/api/backups/settings", async (_request, response) => {
  response.json(await getBackupSettings());
});

app.put("/api/backups/settings", async (request, response) => {
  const current = await getBackupSettings();
  const next = {
    ...current,
    enabled: Boolean(request.body?.enabled),
    intervalHours: Math.max(1, Math.min(Number(request.body?.intervalHours || current.intervalHours), 168)),
    keep: Math.max(3, Math.min(Number(request.body?.keep || current.keep), 60)),
    note: String(request.body?.note || current.note || "")
  };
  await writeJson(backupSettingsPath, next);
  response.json(next);
});

app.get("/api/backups/archive", async (_request, response) => {
  const archive = await createBackupArchive();
  response.setHeader("Content-Type", "application/gzip");
  response.setHeader("Content-Disposition", `attachment; filename="hometab-backups-${new Date().toISOString().slice(0, 10)}.json.gz"`);
  response.send(archive);
});

app.get("/api/backups/:name", async (request, response) => {
  const name = String(request.params.name || "");
  if (!isSafeBackupName(name)) {
    response.status(400).json({ error: "Invalid backup name" });
    return;
  }

  const payload = await readJson(path.join(backupDir, name), null);
  if (!payload) {
    response.status(404).json({ error: "Backup not found" });
    return;
  }
  response.json(payload);
});

app.get("/api/backups/:name/compare", async (request, response) => {
  const name = String(request.params.name || "");
  if (!isSafeBackupName(name)) {
    response.status(400).json({ error: "Invalid backup name" });
    return;
  }
  const payload = await readJson(path.join(backupDir, name), null);
  if (!payload) {
    response.status(404).json({ error: "Backup not found" });
    return;
  }
  response.json({ backup: summarizeBackup(name, payload), diff: backupDiff(await buildBackupPayload(), payload) });
});

app.post("/api/backups/:name/restore", async (request, response) => {
  const name = String(request.params.name || "");
  if (!isSafeBackupName(name)) {
    response.status(400).json({ error: "Invalid backup name" });
    return;
  }

  const payload = await readJson(path.join(backupDir, name), null);
  if (!payload?.config || !Array.isArray(payload.customBookmarks)) {
    response.status(404).json({ error: "Backup not found or invalid" });
    return;
  }

  const current = await buildBackupPayload();
  await createBackupSnapshot({ ...current, exportedAt: new Date().toISOString() }, { source: "before-restore", note: `恢复 ${name} 前自动备份` });
  const nextBookmarks = payload.customBookmarks.slice(0, 80);
  await Promise.all([writeJson(runtimeConfigPath, payload.config), writeJson(bookmarksPath, nextBookmarks)]);
  response.json({ ok: true, config: payload.config, customBookmarks: nextBookmarks });
});

app.get("/api/connections", async (_request, response) => {
  const connections = await getConnections();
  response.json({
    fnos: {
      url: connections.fnos.url,
      sshHost: connections.fnos.sshHost,
      sshPort: connections.fnos.sshPort,
      sshUsername: connections.fnos.sshUsername,
      sshPasswordConfigured: Boolean(connections.fnos.sshPassword)
    },
    pve: {
      url: connections.pve.url,
      username: connections.pve.username,
      tokenId: connections.pve.tokenId,
      tokenConfigured: Boolean(connections.pve.tokenSecret),
      passwordConfigured: Boolean(connections.pve.password),
      tlsVerify: connections.pve.tlsVerify
    }
  });
});

app.put("/api/connections", async (request, response) => {
  const current = await getConnections();
  const next = {
    fnos: {
      url: String(request.body?.fnos?.url || current.fnos.url || ""),
      sshHost: String(request.body?.fnos?.sshHost || current.fnos.sshHost || ""),
      sshPort: Number(request.body?.fnos?.sshPort || current.fnos.sshPort || 22),
      sshUsername: String(request.body?.fnos?.sshUsername || current.fnos.sshUsername || ""),
      sshPassword: request.body?.fnos?.sshPassword ? String(request.body.fnos.sshPassword) : current.fnos.sshPassword
    },
    pve: {
      url: String(request.body?.pve?.url || current.pve.url || ""),
      username: String(request.body?.pve?.username || current.pve.username || ""),
      password: request.body?.pve?.password ? String(request.body.pve.password) : current.pve.password,
      tokenId: String(request.body?.pve?.tokenId || current.pve.tokenId || ""),
      tokenSecret: request.body?.pve?.tokenSecret ? String(request.body.pve.tokenSecret) : current.pve.tokenSecret,
      tlsVerify: Boolean(request.body?.pve?.tlsVerify)
    }
  };

  await writeJson(connectionsPath, next);
  response.json({ ok: true });
});

app.post("/api/logo-preview", (request, response) => {
  const url = normalizeUrl(request.body?.url);
  const host = hostnameOf(url);
  if (!host) {
    response.status(400).json({ error: "Valid url is required" });
    return;
  }
  response.json({
    url,
    hostname: host,
    name: host.replace(/^www\./, "").split(".")[0],
    candidates: logoCandidates(url, request.body?.logoUrl)
  });
});

app.get("/api/docker/containers", async (_request, response) => {
  response.json(await getDockerStatus());
});

app.get("/api/docker/containers/:id", async (request, response) => {
  try {
    response.json(await getDockerContainerDetail(request.params.id));
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/docker/containers/:id/:action", async (request, response, next) => {
  const allowed = new Set(["start", "stop", "restart"]);
  if (!allowed.has(request.params.action)) {
    next();
    return;
  }
  if (!(await requireAuth(request, response))) return;

  try {
    const cooldown = checkCooldown("docker", request.params.id, request.params.action);
    if (!cooldown.ok) {
      response.status(429).json({ error: "Operation cooling down", ...cooldown });
      return;
    }
    await saveContainerBackup(request.params.id, `before-${request.params.action}`);
    await runFnosDocker(`${request.params.action} ${shellQuote(request.params.id)}`);
    let undo = null;
    if (request.params.action === "stop") {
      const token = undoToken();
      undo = { token, action: "start", expiresAt: new Date(Date.now() + 30_000).toISOString() };
      undoWindows.set(token, { scope: "docker", id: request.params.id, action: "start", expiresAt: Date.now() + 30_000 });
    }
    await appendAudit({ actor: request.ip, action: `docker.${request.params.action}`, target: request.params.id, detail: "Docker action executed", severity: "info", result: "success" });
    await sendNotification(`Docker ${request.params.action}`, `${request.params.id} 操作已执行。`, "info");
    response.json({ ok: true, cooldown, undo });
  } catch (error) {
    await appendAudit({ actor: request.ip, action: `docker.${request.params.action}`, target: request.params.id, detail: "Docker action failed", severity: "warn", result: "failed", error: error.message });
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/docker/undo/:token", async (request, response) => {
  if (!(await requireAuth(request, response))) return;
  const undo = undoWindows.get(request.params.token);
  if (!undo || undo.expiresAt < Date.now()) {
    response.status(410).json({ error: "Undo window expired" });
    return;
  }
  try {
    if (undo.action === "rollback" && undo.backup) {
      const payload = await readJson(path.join(containerBackupDir, undo.backup), null);
      if (!payload?.inspect) throw new Error("Rollback backup not found");
      await runFnosDocker(`rm -f ${shellQuote(safeContainerName(payload.inspect.Name))}`);
      await runFnosDocker(dockerRunArgsFromInspect(payload.inspect));
    } else {
      await runFnosDocker(`${undo.action} ${shellQuote(undo.id)}`);
    }
    undoWindows.delete(request.params.token);
    await appendAudit({ actor: request.ip, action: `docker.undo.${undo.action}`, target: undo.id, detail: "撤销窗口内恢复操作", severity: "info", result: "success" });
    response.json({ ok: true });
  } catch (error) {
    await appendAudit({ actor: request.ip, action: `docker.undo.${undo.action}`, target: undo.id, detail: "撤销失败", severity: "warn", result: "failed", error: error.message });
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/docker/containers/:id/operation-preview", async (request, response) => {
  try {
    const inspect = await inspectContainer(request.params.id);
    response.json({ ok: true, ...dockerRecreateSafety(inspect) });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/docker/containers/:id/update", async (request, response) => {
  try {
    response.json(await containerUpdateReport(request.params.id));
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/docker/updates", async (_request, response) => {
  try {
    const dockerStatus = await getDockerStatus();
    if (!dockerStatus.available) {
      response.status(503).json({ error: dockerStatus.error || "Docker unavailable" });
      return;
    }
    const reports = await Promise.all(dockerStatus.services.map((container) => containerUpdateReport(container.id).catch((error) => ({
      ok: false,
      id: container.id,
      image: container.image,
      name: container.name,
      error: error.message
    }))));
    response.json({ ok: true, reports });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/docker/containers/:id/pull", async (request, response) => {
  if (!(await requireAuth(request, response))) return;
  try {
    const cooldown = checkCooldown("docker", request.params.id, "pull", 60);
    if (!cooldown.ok) {
      response.status(429).json({ error: "Operation cooling down", ...cooldown });
      return;
    }
    const detail = await getDockerContainerDetail(request.params.id);
    await saveContainerBackup(request.params.id, "before-pull");
    const output = await runFnosDocker(`pull ${shellQuote(detail.image)}`);
    await appendAudit({ actor: request.ip, action: "docker.pull", target: detail.name || request.params.id, detail: detail.image, severity: "info", result: "success" });
    await sendNotification("Docker 镜像已拉取", `${detail.name || request.params.id} · ${detail.image}`, "info");
    response.json({ ok: true, image: detail.image, output });
  } catch (error) {
    await appendAudit({ actor: request.ip, action: "docker.pull", target: request.params.id, detail: "镜像拉取失败", severity: "warn", result: "failed", error: error.message });
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/docker/containers/:id/recreate", async (request, response) => {
  if (!(await requireAuth(request, response))) return;
  try {
    const cooldown = checkCooldown("docker", request.params.id, "recreate", 60);
    if (!cooldown.ok) {
      response.status(429).json({ error: "Operation cooling down", ...cooldown });
      return;
    }
    const backup = await saveContainerBackup(request.params.id, "before-recreate");
    const inspect = backup.payload.inspect;
    const safety = dockerRecreateSafety(inspect);
    if (!safety.safe && !request.body?.force) {
      response.status(409).json({ error: "Container has risky options", safety });
      return;
    }
    const name = safeContainerName(inspect.Name);
    const runArgs = dockerRunArgsFromInspect(inspect);
    await runFnosDocker(`rm -f ${shellQuote(name)}`);
    const output = await runFnosDocker(runArgs);
    const token = undoToken();
    undoWindows.set(token, { scope: "docker", id: name, action: "rollback", backup: backup.filename, expiresAt: Date.now() + 60_000 });
    await appendAudit({ actor: request.ip, action: "docker.recreate", target: name, detail: backup.filename, severity: "warn", result: "success" });
    await sendNotification("Docker 容器已重建", `${name} 已根据备份配置重建。`, "warn");
    response.json({ ok: true, backup: backup.filename, output, undo: { token, action: "rollback", expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  } catch (error) {
    await appendAudit({ actor: request.ip, action: "docker.recreate", target: request.params.id, detail: "容器重建失败", severity: "warn", result: "failed", error: error.message });
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/docker/updates/bulk-safe", async (request, response) => {
  if (!(await requirePassword(request, response))) return;
  try {
    const dockerStatus = await getDockerStatus();
    if (!dockerStatus.available) {
      response.status(503).json({ error: dockerStatus.error || "Docker unavailable" });
      return;
    }
    const candidates = [];
    for (const container of dockerStatus.services) {
      const report = await containerUpdateReport(container.id).catch(() => null);
      if (report?.hasUpdate && report.safety?.safe) candidates.push({ container, report });
    }
    const results = [];
    for (const item of candidates) {
      const backup = await saveContainerBackup(item.container.id, "before-bulk-update");
      const pullOutput = await runFnosDocker(`pull ${shellQuote(item.report.image)}`);
      const runArgs = dockerRunArgsFromInspect(backup.payload.inspect);
      await runFnosDocker(`rm -f ${shellQuote(safeContainerName(backup.payload.inspect.Name))}`);
      const recreateOutput = await runFnosDocker(runArgs);
      results.push({ name: item.container.name, image: item.report.image, backup: backup.filename, pullOutput, recreateOutput });
    }
    await appendAudit({ actor: request.ip, action: "docker.bulk-safe-update", target: "docker", detail: `${results.length} 个容器已安全更新`, severity: results.length ? "warn" : "info", result: "success" });
    response.json({ ok: true, updated: results.length, results });
  } catch (error) {
    await appendAudit({ actor: request.ip, action: "docker.bulk-safe-update", target: "docker", detail: "批量安全更新失败", severity: "warn", result: "failed", error: error.message });
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/docker/backups", async (request, response) => {
  if (!(await requireAuth(request, response))) return;
  response.json({ backups: await listContainerBackups(request.query.container || "") });
});

app.post("/api/docker/backups/:name/rollback", async (request, response) => {
  if (!(await requireAuth(request, response))) return;
  const name = String(request.params.name || "");
  if (!/^[a-zA-Z0-9_.-]+-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(name)) {
    response.status(400).json({ error: "Invalid backup name" });
    return;
  }
  const payload = await readJson(path.join(containerBackupDir, name), null);
  if (!payload?.inspect) {
    response.status(404).json({ error: "Backup not found" });
    return;
  }
  try {
    const containerName = safeContainerName(payload.inspect.Name);
    const runArgs = dockerRunArgsFromInspect(payload.inspect);
    await runFnosDocker(`rm -f ${shellQuote(containerName)}`);
    const output = await runFnosDocker(runArgs);
    await appendAudit({ actor: request.ip, action: "docker.rollback", target: containerName, detail: name, severity: "warn" });
    response.json({ ok: true, output });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/docker/containers/:id/logs", async (request, response) => {
  try {
    const tail = Math.max(20, Math.min(Number(request.query.tail || 300), 1000));
    const logs = await runFnosDocker(`logs --tail ${tail} ${shellQuote(request.params.id)} 2>&1`);
    response.type("text/plain").send(logs);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/pve/status", async (_request, response) => {
  response.json(await getPveStatus());
});

app.post("/api/pve/:node/:type/:vmid/:action", async (request, response) => {
  if (!(await requireAuth(request, response))) return;
  const allowed = new Set(["start", "shutdown", "reboot", "stop"]);
  const { node, type, vmid, action } = request.params;
  if (!allowed.has(action) || !["qemu", "lxc"].includes(type)) {
    response.status(400).json({ error: "Unsupported PVE action" });
    return;
  }

  try {
    const cooldown = checkCooldown("pve", `${type}-${vmid}`, action, 30);
    if (!cooldown.ok) {
      response.status(429).json({ error: "Operation cooling down", ...cooldown });
      return;
    }
    const data = await pveFetch(
      `/nodes/${encodeURIComponent(node)}/${type}/${encodeURIComponent(vmid)}/status/${action}`,
      { method: "POST" }
    );
    await appendAudit({ actor: request.ip, action: `pve.${action}`, target: `${type}/${vmid}`, detail: node, severity: action === "stop" ? "warn" : "info", result: "success" });
    await sendNotification(`PVE ${action}`, `${type.toUpperCase()} ${vmid} 操作已提交。`, action === "stop" ? "warn" : "info");
    response.json({ ok: true, data, cooldown });
  } catch (error) {
    await appendAudit({ actor: request.ip, action: `pve.${action}`, target: `${type}/${vmid}`, detail: node, severity: "warn", result: "failed", error: error.message });
    response.status(500).json({ error: error.message });
  }
});

app.use(express.static(distDir));
app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(distDir, "index.html"));
});

app.listen(port, () => {
  console.log(`HomeTab Pilot listening on ${port}`);
});
