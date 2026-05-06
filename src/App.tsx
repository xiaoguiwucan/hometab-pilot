import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  siDocker,
  siEmby,
  siGithub,
  siGmail,
  siJellyfin,
  siLinux,
  siOpenwrt,
  siProxmox,
  siQbittorrent
} from "simple-icons";

type Bookmark = {
  name: string;
  url: string;
  category: string;
  icon: string;
  color: string;
  logoUrl?: string;
  status?: "online" | "warning" | "offline";
};

type Favorite = string | {
  title: string;
  url: string;
  subtitle?: string;
  icon?: string;
};

type AppConfig = {
  categories: string[];
  bookmarks: Bookmark[];
  bookmarkOrder?: string[];
  folders: string[];
  recent: string[];
  favorites: Favorite[];
  systems: {
    fnos: { status: string; storage: number; cpu: number; memory: number };
    pve: { status: string; vms: number; chips: string[] };
    containers: { running: number; services: string[] };
  };
};

type BackupPayload = {
  version?: number;
  exportedAt?: string;
  source?: string;
  note?: string;
  config?: AppConfig;
  customBookmarks?: Bookmark[];
};

type BackupSummary = {
  name: string;
  exportedAt?: string;
  version?: string | number;
  source?: string;
  note?: string;
  configBookmarks: number;
  customBookmarks: number;
  categories: number;
  size?: number;
};

type AuthStatus = {
  configured: boolean;
  required: boolean;
  authenticated: boolean;
};

type NotificationPublicSettings = {
  enabled: boolean;
  barkConfigured: boolean;
  serverChanConfigured: boolean;
  telegramConfigured: boolean;
  webhookConfigured: boolean;
  wecomConfigured: boolean;
  quietMinutes: number;
  dailySummaryEnabled: boolean;
  dailySummaryHour: number;
  lastDailySummaryDate?: string;
};

type NotificationSettingsDraft = NotificationPublicSettings & {
  barkUrl: string;
  serverChanKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  webhookUrl: string;
  wecomWebhookUrl: string;
};

type DockerUpdateReport = {
  ok: boolean;
  id: string;
  image: string;
  localDigest?: string;
  remoteDigest?: string;
  hasUpdate?: boolean;
  safety?: {
    safe: boolean;
    risks: string[];
    summary: {
      image: string;
      imageId?: string;
      command?: string;
      mounts?: Array<{ type?: string; source?: string; destination?: string; mode?: string }>;
      ports?: Record<string, unknown>;
      env?: string[];
      restartPolicy?: string;
      networkMode?: string;
      runCommand?: string;
    };
  };
  backups?: BackupSummary[];
  error?: string;
};

type AuditEvent = {
  id: string;
  at: string;
  actor?: string;
  action?: string;
  target?: string;
  detail?: string;
  severity?: EventSeverity;
  result?: "success" | "failed" | string;
  error?: string;
};

type BackupSettings = {
  enabled: boolean;
  intervalHours: number;
  keep: number;
  lastRunAt?: string;
  note?: string;
};

type RuntimeStatus = {
  fnos?: {
    available: boolean;
    status: string;
    storage: number;
    cpu: number;
    memory: number;
    url?: string;
    httpAvailable?: boolean;
    sshAvailable?: boolean;
    sshHost?: string;
    error?: string;
  };
  pve?: {
    available: boolean;
    node: string;
    cpu?: number;
    memory?: number;
    storage?: number;
    vms: Array<{
      vmid: number;
      name?: string;
      status: string;
      type: "qemu" | "lxc" | string;
      node?: string;
      cpu?: number;
      mem?: number;
      maxmem?: number;
    }>;
    error?: string;
  };
  docker?: {
    available: boolean;
    running: number;
    total: number;
    services: Array<{
      id: string;
      name: string;
      image: string;
      state: string;
      status: string;
      cpu?: string;
      memory?: string;
      memoryUsage?: string;
      network?: string;
      block?: string;
      pids?: string;
      portsText?: string;
      health?: string;
      accessUrls?: Array<{ label: string; url: string; hostPort: string; webStatus?: "ok" | "warn" | "error"; httpStatus?: number; latencyMs?: number; checkedAt?: string; error?: string }>;
      restartPolicy?: string;
    }>;
    error?: string;
  };
};

type DiagnosticCheck = {
  id: string;
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
};

type RuntimePayload = {
  config: AppConfig;
  customBookmarks: Bookmark[];
  status: RuntimeStatus;
  generatedAt?: string;
  diagnostics?: DiagnosticCheck[];
};

type SyncWebBookmarksPayload = {
  ok: boolean;
  category: string;
  synced: number;
  bookmarks: Bookmark[];
  config: AppConfig;
  items: Bookmark[];
  checkedAt: string;
};

type ConnectionSettings = {
  fnos: {
    url: string;
    sshHost: string;
    sshPort: number;
    sshUsername: string;
    sshPassword?: string;
    sshPasswordConfigured?: boolean;
  };
  pve: {
    url: string;
    username: string;
    password?: string;
    passwordConfigured?: boolean;
    tokenId: string;
    tokenSecret?: string;
    tokenConfigured?: boolean;
    tlsVerify: boolean;
  };
};

type MetricPoint = {
  ts: number;
  value: number;
};

type RuntimeHistory = {
  fnos: Record<"cpu" | "memory" | "storage", MetricPoint[]>;
  pve: Record<"cpu" | "memory" | "storage" | "vms", MetricPoint[]>;
  containers: Record<string, Record<"cpu" | "memory" | "network", MetricPoint[]>>;
};

type EventSeverity = "info" | "warn" | "critical";

type RuntimeEvent = {
  id: string;
  ts: number;
  title: string;
  detail: string;
  severity: EventSeverity;
  source: "FNOS" | "PVE" | "Docker" | "System" | "Audit";
};

type AlertPair = {
  warn: number;
  critical: number;
};

type AlertRules = {
  fnos: Record<"cpu" | "memory" | "storage", AlertPair>;
  pve: Record<"cpu" | "memory" | "storage", AlertPair>;
  docker: Record<"cpu" | "memory", AlertPair>;
};

type DockerService = NonNullable<RuntimeStatus["docker"]>["services"][number];
type PveVm = NonNullable<RuntimeStatus["pve"]>["vms"][number];
type PveAction = "start" | "shutdown" | "reboot" | "stop";

type ThemeId = "liquid" | "cyber" | "hacker" | "pixel" | "hud";

const emptyConnections: ConnectionSettings = {
  fnos: { url: "", sshHost: "", sshPort: 22, sshUsername: "" },
  pve: { url: "", username: "", tokenId: "", tlsVerify: false }
};

const fallbackConfig: AppConfig = {
  categories: ["常用", "NAS", "AI", "下载", "影音", "开发", "工具", "生活"],
  bookmarks: [],
  folders: ["NAS", "AI", "下载", "影音"],
  recent: ["飞牛OS", "PVE 控制台", "qBittorrent", "GitHub", "Docker 容器"],
  favorites: [
    { title: "少数派 - 高效工作，品质生活", url: "https://sspai.com", subtitle: "sspai.com", icon: "π" },
    { title: "TG频道大全", url: "https://t.me", subtitle: "telegram.org", icon: "↗" }
  ],
  systems: {
    fnos: { status: "已连接", storage: 78, cpu: 34, memory: 57 },
    pve: { status: "node-01 在线", vms: 6, chips: ["OpenWrt", "FNOS", "Ubuntu"] },
    containers: { running: 12, services: ["qbit", "emby", "cloud", "qinglong"] }
  }
};

const navItems = [
  { label: "首页", icon: "home" },
  { label: "书签", icon: "bookmark" },
  { label: "添加网址", icon: "plusCircle" },
  { label: "导入书签", icon: "download" },
  { label: "主题", icon: "image" },
  { label: "设置", icon: "settings" },
  { label: "备份", icon: "cloudUpload" }
];

const themeOptions: Array<{ id: ThemeId; name: string; tone: string }> = [
  { id: "liquid", name: "macOS 流体玻璃", tone: "Glass" },
  { id: "cyber", name: "赛博朋克霓虹", tone: "Cyber" },
  { id: "hacker", name: "黑客代码终端", tone: "Code" },
  { id: "pixel", name: "16 比特动画", tone: "16bit" },
  { id: "hud", name: "Future White HUD", tone: "HUD" }
];

const brandIconMap = {
  PVE: siProxmox,
  qBittorrent: siQbittorrent,
  Emby: siEmby,
  OpenWrt: siOpenwrt,
  GitHub: siGithub,
  "Linux.do": siLinux,
  Gmail: siGmail,
  Jellyfin: siJellyfin,
  影视库: siJellyfin,
  下载站: siQbittorrent,
  Docker: siDocker
} as const;

const localBookmarkKey = "hometab.customBookmarks.v1";
const localConfigKey = "hometab.configDraft.v1";
const localEventsKey = "hometab.runtimeEvents.v1";
const localAlertRulesKey = "hometab.alertRules.v1";
const authTokenKey = "hometab.authToken.v1";
const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

const defaultAlertRules: AlertRules = {
  fnos: {
    cpu: { warn: 80, critical: 92 },
    memory: { warn: 85, critical: 95 },
    storage: { warn: 85, critical: 95 }
  },
  pve: {
    cpu: { warn: 80, critical: 92 },
    memory: { warn: 85, critical: 95 },
    storage: { warn: 85, critical: 95 }
  },
  docker: {
    cpu: { warn: 80, critical: 95 },
    memory: { warn: 80, critical: 95 }
  }
};

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function bookmarkKey(value: string) {
  return normalizeUrl(value).toLowerCase();
}

function sortBookmarksByOrder(bookmarks: Bookmark[], order: string[] = []) {
  const positions = new Map(order.map((url, index) => [bookmarkKey(url), index]));
  return [...bookmarks].sort((a, b) => {
    const aIndex = positions.get(bookmarkKey(a.url));
    const bIndex = positions.get(bookmarkKey(b.url));
    if (aIndex === undefined && bIndex === undefined) return 0;
    if (aIndex === undefined) return 1;
    if (bIndex === undefined) return -1;
    return aIndex - bIndex;
  });
}

function getHostname(value: string) {
  try {
    return new URL(normalizeUrl(value)).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function getLogoCandidates(bookmark: Pick<Bookmark, "url" | "logoUrl">) {
  const url = normalizeUrl(bookmark.url);
  const candidates: string[] = [];

  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const isPrivateHost = host.endsWith(".local")
      || host.endsWith(".lan")
      || host === "localhost"
      || !host.includes(".")
      || /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
    if (bookmark.logoUrl) {
      const logoHost = new URL(bookmark.logoUrl, parsed.origin).hostname;
      if (!isPrivateHost || logoHost !== host) candidates.push(bookmark.logoUrl);
    }
    if (isPrivateHost) {
      return [...new Set(candidates.filter(Boolean))];
    }
    candidates.push(`${parsed.origin}/favicon.ico`);
    candidates.push(`${parsed.origin}/apple-touch-icon.png`);
    candidates.push(`${parsed.origin}/apple-touch-icon-precomposed.png`);
    candidates.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`);
    candidates.push(`https://icons.duckduckgo.com/ip3/${host}.ico`);
  } catch {
    // Invalid input is handled by the add form.
  }

  return [...new Set(candidates.filter(Boolean))];
}

function readLocalBookmarks() {
  try {
    const value = window.localStorage.getItem(localBookmarkKey);
    return value ? (JSON.parse(value) as Bookmark[]) : [];
  } catch {
    return [];
  }
}

function writeLocalBookmarks(bookmarks: Bookmark[]) {
  window.localStorage.setItem(localBookmarkKey, JSON.stringify(bookmarks));
}

function authHeaders(token: string) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function readRuntimeEvents() {
  try {
    const value = window.localStorage.getItem(localEventsKey);
    return value ? (JSON.parse(value) as RuntimeEvent[]) : [];
  } catch {
    return [];
  }
}

function writeRuntimeEvents(events: RuntimeEvent[]) {
  window.localStorage.setItem(localEventsKey, JSON.stringify(events.slice(0, 80)));
}

function normalizeAlertPair(value: Partial<AlertPair> | undefined, fallback: AlertPair): AlertPair {
  const warn = Number(value?.warn);
  const critical = Number(value?.critical);
  const nextWarn = Number.isFinite(warn) ? Math.max(1, Math.min(99, Math.round(warn))) : fallback.warn;
  const nextCritical = Number.isFinite(critical) ? Math.max(nextWarn + 1, Math.min(100, Math.round(critical))) : fallback.critical;
  return {
    warn: nextWarn,
    critical: Math.max(nextWarn + 1, nextCritical)
  };
}

function normalizeAlertRules(value?: Partial<AlertRules>): AlertRules {
  return {
    fnos: {
      cpu: normalizeAlertPair(value?.fnos?.cpu, defaultAlertRules.fnos.cpu),
      memory: normalizeAlertPair(value?.fnos?.memory, defaultAlertRules.fnos.memory),
      storage: normalizeAlertPair(value?.fnos?.storage, defaultAlertRules.fnos.storage)
    },
    pve: {
      cpu: normalizeAlertPair(value?.pve?.cpu, defaultAlertRules.pve.cpu),
      memory: normalizeAlertPair(value?.pve?.memory, defaultAlertRules.pve.memory),
      storage: normalizeAlertPair(value?.pve?.storage, defaultAlertRules.pve.storage)
    },
    docker: {
      cpu: normalizeAlertPair(value?.docker?.cpu, defaultAlertRules.docker.cpu),
      memory: normalizeAlertPair(value?.docker?.memory, defaultAlertRules.docker.memory)
    }
  };
}

function readAlertRules() {
  try {
    const value = window.localStorage.getItem(localAlertRulesKey);
    return value ? normalizeAlertRules(JSON.parse(value) as Partial<AlertRules>) : defaultAlertRules;
  } catch {
    return defaultAlertRules;
  }
}

function writeAlertRules(rules: AlertRules) {
  window.localStorage.setItem(localAlertRulesKey, JSON.stringify(normalizeAlertRules(rules)));
}

function readLocalConfig() {
  try {
    const value = window.localStorage.getItem(localConfigKey);
    return value ? (JSON.parse(value) as AppConfig) : fallbackConfig;
  } catch {
    return fallbackConfig;
  }
}

function hasLocalConfig() {
  return Boolean(window.localStorage.getItem(localConfigKey));
}

function openUrl(url?: string) {
  if (!url) return false;
  const normalized = normalizeUrl(url);
  if (!normalized) return false;
  window.open(normalized, "_blank", "noopener,noreferrer");
  return true;
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadText(filename: string, value: string) {
  const blob = new Blob([value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function downloadResponse(filename: string, response: Response) {
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "container";
}

function readPercent(value?: string | number) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const parsed = Number.parseFloat(String(value).replace("%", ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
}

function emptyRuntimeHistory(): RuntimeHistory {
  return {
    fnos: { cpu: [], memory: [], storage: [] },
    pve: { cpu: [], memory: [], storage: [], vms: [] },
    containers: {}
  };
}

function appendMetric(points: MetricPoint[], value?: number, ts = Date.now(), max = 48) {
  const nextValue = Number.isFinite(value) ? Math.max(0, Math.min(100, Number(value))) : undefined;
  if (nextValue === undefined) return points;
  return [...points, { ts, value: nextValue }].slice(-max);
}

function parseBytes(value: string) {
  const match = value.match(/([\d.]+)\s*([KMGT]?i?B)/i);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const scale = unit.startsWith("T") ? 1024 ** 4 : unit.startsWith("G") ? 1024 ** 3 : unit.startsWith("M") ? 1024 ** 2 : unit.startsWith("K") ? 1024 : 1;
  return Number.isFinite(amount) ? amount * scale : 0;
}

function readNetworkScore(value?: string) {
  if (!value) return 0;
  const bytes = value
    .split("/")
    .map((part) => parseBytes(part.trim()))
    .reduce((sum, item) => sum + item, 0);
  if (!bytes) return 0;
  return Math.max(2, Math.min(100, Math.log10(bytes + 1) * 10));
}

function appendRuntimeHistory(current: RuntimeHistory, status: RuntimeStatus, ts = Date.now()): RuntimeHistory {
  const containers: RuntimeHistory["containers"] = {};
  const services = status.docker?.services || [];

  for (const service of services) {
    const key = service.id || service.name;
    if (!key) continue;
    const previous = current.containers[key] || { cpu: [], memory: [], network: [] };
    containers[key] = {
      cpu: appendMetric(previous.cpu, readPercent(service.cpu), ts),
      memory: appendMetric(previous.memory, readPercent(service.memory), ts),
      network: appendMetric(previous.network, readNetworkScore(service.network), ts)
    };
  }

  return {
    fnos: {
      cpu: appendMetric(current.fnos.cpu, status.fnos?.cpu, ts),
      memory: appendMetric(current.fnos.memory, status.fnos?.memory, ts),
      storage: appendMetric(current.fnos.storage, status.fnos?.storage, ts)
    },
    pve: {
      cpu: appendMetric(current.pve.cpu, status.pve?.cpu, ts),
      memory: appendMetric(current.pve.memory, status.pve?.memory, ts),
      storage: appendMetric(current.pve.storage, status.pve?.storage, ts),
      vms: appendMetric(current.pve.vms, Math.min(100, (status.pve?.vms?.length || 0) * 10), ts)
    },
    containers
  };
}

function metricValues(points: MetricPoint[], fallback: number) {
  if (points.length >= 2) return points.map((point) => point.value);
  return [fallback, fallback];
}

function formatRefreshTime(value?: string) {
  if (!value) return "等待刷新";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "等待刷新";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function formatDateTime(value?: string) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function healthText(value?: string) {
  if (!value) return "无健康检查";
  const map: Record<string, string> = {
    healthy: "健康",
    unhealthy: "异常",
    starting: "启动中"
  };
  return map[value] || value;
}

function webStatusText(value?: string, httpStatus?: number) {
  if (value === "ok") return httpStatus ? `HTTP ${httpStatus}` : "可访问";
  if (value === "warn") return httpStatus ? `HTTP ${httpStatus}` : "需检查";
  if (value === "error") return "不可达";
  return "未检测";
}

function cleanLogLine(line: string) {
  return line
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "")
    .replace(/[^\S\n]+/g, " ")
    .trimEnd();
}

function logLineLevel(line: string) {
  if (/error|fail|fatal|exception|panic|traceback/i.test(line)) return "error";
  if (/warn|warning|timeout|retry/i.test(line)) return "warn";
  if (/success|ready|started|listening|healthy|connected/i.test(line)) return "ok";
  return "default";
}

function eventTime(ts: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(ts));
}

function eventDateLabel(ts: number) {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return "今天";
  if (sameDay(date, yesterday)) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}

function formatBytes(bytes?: number) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  return `${next >= 10 ? next.toFixed(0) : next.toFixed(1)} ${units[index]}`;
}

function eventLevel(value: number, warn: number, critical: number) {
  if (value >= critical) return "critical";
  if (value >= warn) return "warn";
  return "ok";
}

function buildRuntimeEvents(
  status: RuntimeStatus,
  diagnostics: DiagnosticCheck[],
  previousStatus: RuntimeStatus | undefined,
  previousDiagnostics: DiagnosticCheck[],
  signals: Record<string, string>,
  alertRules: AlertRules,
  ts = Date.now()
) {
  const events: RuntimeEvent[] = [];

  function push(key: string, severity: EventSeverity, source: RuntimeEvent["source"], title: string, detail: string) {
    events.push({
      id: `${ts}-${key}-${events.length}`,
      ts,
      title,
      detail,
      severity,
      source
    });
  }

  function threshold(key: string, source: RuntimeEvent["source"], label: string, value: number | undefined, warn: number, critical: number) {
    if (!Number.isFinite(value)) return;
    const current = eventLevel(Number(value), warn, critical);
    const previous = signals[key];
    if (previous === current) return;
    signals[key] = current;
    if (current === "ok") {
      if (previous && previous !== "ok") push(key, "info", source, `${label} 已恢复`, `当前 ${Math.round(Number(value))}%`);
      return;
    }
    push(key, current, source, `${label} ${current === "critical" ? "严重" : "偏高"}`, `当前 ${Math.round(Number(value))}%`);
  }

  threshold("fnos:cpu", "FNOS", "FNOS CPU", status.fnos?.cpu, alertRules.fnos.cpu.warn, alertRules.fnos.cpu.critical);
  threshold("fnos:memory", "FNOS", "FNOS 内存", status.fnos?.memory, alertRules.fnos.memory.warn, alertRules.fnos.memory.critical);
  threshold("fnos:storage", "FNOS", "FNOS 存储", status.fnos?.storage, alertRules.fnos.storage.warn, alertRules.fnos.storage.critical);
  threshold("pve:cpu", "PVE", "PVE CPU", status.pve?.cpu, alertRules.pve.cpu.warn, alertRules.pve.cpu.critical);
  threshold("pve:memory", "PVE", "PVE 内存", status.pve?.memory, alertRules.pve.memory.warn, alertRules.pve.memory.critical);
  threshold("pve:storage", "PVE", "PVE 存储", status.pve?.storage, alertRules.pve.storage.warn, alertRules.pve.storage.critical);

  for (const service of status.docker?.services || []) {
    const key = service.id || service.name;
    if (!key) continue;
    const name = service.name || key.slice(0, 12);
    threshold(`docker:${key}:cpu`, "Docker", `${name} CPU`, readPercent(service.cpu), alertRules.docker.cpu.warn, alertRules.docker.cpu.critical);
    threshold(`docker:${key}:memory`, "Docker", `${name} 内存`, readPercent(service.memory), alertRules.docker.memory.warn, alertRules.docker.memory.critical);

    const previousService = previousStatus?.docker?.services?.find((item) => (item.id || item.name) === key);
    if (previousService && previousService.state !== service.state) {
      push(`docker:${key}:state`, service.state === "running" ? "info" : "warn", "Docker", `${name} 状态变化`, `${previousService.state || "unknown"} → ${service.state || "unknown"}`);
    }
    if (service.health && previousService && previousService.health !== service.health) {
      push(`docker:${key}:health`, service.health === "unhealthy" ? "critical" : service.health === "healthy" ? "info" : "warn", "Docker", `${name} 健康状态`, healthText(service.health));
    }
  }

  for (const vm of status.pve?.vms || []) {
    const key = `${vm.type}:${vm.vmid}`;
    const previousVm = previousStatus?.pve?.vms?.find((item) => `${item.type}:${item.vmid}` === key);
    if (previousVm && previousVm.status !== vm.status) {
      push(`pve:${key}:status`, vm.status === "running" ? "info" : "warn", "PVE", `${vm.name || vm.vmid} 状态变化`, `${previousVm.status} → ${vm.status}`);
    }
  }

  const previousDiagnosticMap = new Map(previousDiagnostics.map((item) => [item.id, item.status]));
  for (const item of diagnostics) {
    const previous = previousDiagnosticMap.get(item.id);
    if (previous === item.status) continue;
    if (item.status === "ok" && previous && previous !== "ok") {
      push(`diagnostic:${item.id}`, "info", "System", `${item.label} 已恢复`, item.detail);
    } else if (item.status !== "ok") {
      push(`diagnostic:${item.id}`, item.status === "error" ? "critical" : "warn", "System", `${item.label} 异常`, item.detail);
    }
  }

  return events;
}

function parseImportedBookmarks(text: string, category: string) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  try {
    const payload = JSON.parse(trimmed) as unknown;
    const items = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { bookmarks?: unknown[] }).bookmarks)
        ? (payload as { bookmarks: unknown[] }).bookmarks
        : [];
    return items
      .map((item) => item as Partial<Bookmark>)
      .filter((item) => item.url)
      .map((item) => {
        const url = normalizeUrl(String(item.url));
        const name = String(item.name || getHostname(url) || "新书签");
        return {
          name,
          url,
          category: String(item.category || category),
          icon: String(item.icon || name.slice(0, 1).toUpperCase()),
          color: String(item.color || "light"),
          logoUrl: item.logoUrl
        } satisfies Bookmark;
      });
  } catch {
    return trimmed
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [namePart, urlPart] = line.includes(",") ? line.split(",") : line.split(/\s+/);
        const url = normalizeUrl(urlPart || namePart);
        const name = urlPart ? namePart : getHostname(url) || "新书签";
        return {
          name,
          url,
          category,
          icon: name.slice(0, 1).toUpperCase(),
          color: "light",
          logoUrl: getLogoCandidates({ url })[0]
        } satisfies Bookmark;
      });
  }
}

function useRuntime() {
  const [config, setConfig] = useState<AppConfig>(() => readLocalConfig());
  const [customBookmarks, setCustomBookmarks] = useState<Bookmark[]>(() => readLocalBookmarks());
  const [status, setStatus] = useState<RuntimeStatus>({});
  const [history, setHistory] = useState<RuntimeHistory>(() => emptyRuntimeHistory());
  const [connections, setConnections] = useState<ConnectionSettings>(emptyConnections);
  const [lastRefreshAt, setLastRefreshAt] = useState("");
  const [diagnostics, setDiagnostics] = useState<DiagnosticCheck[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>(() => readRuntimeEvents());
  const [alertRules, setAlertRules] = useState<AlertRules>(() => readAlertRules());
  const runtimeLoadingRef = useRef(false);
  const previousStatusRef = useRef<RuntimeStatus>();
  const previousDiagnosticsRef = useRef<DiagnosticCheck[]>([]);
  const eventSignalsRef = useRef<Record<string, string>>({});
  const alertRulesRef = useRef(alertRules);

  useEffect(() => {
    alertRulesRef.current = alertRules;
  }, [alertRules]);

  function applyRuntime(runtime: RuntimePayload) {
    const nextStatus = runtime.status || {};
    const nextDiagnostics = runtime.diagnostics || [];
    const nextEvents = buildRuntimeEvents(nextStatus, nextDiagnostics, previousStatusRef.current, previousDiagnosticsRef.current, eventSignalsRef.current, alertRulesRef.current);
    setConfig(runtime.config);
    setCustomBookmarks(runtime.customBookmarks);
    setStatus(nextStatus);
    setLastRefreshAt(runtime.generatedAt || new Date().toISOString());
    setDiagnostics(nextDiagnostics);
    setHistory((current) => appendRuntimeHistory(current, nextStatus));
    if (nextEvents.length) {
      setEvents((current) => {
        const freshEvents = nextEvents.filter((event) => !current.some((item) => (
          item.source === event.source &&
          item.severity === event.severity &&
          item.title === event.title &&
          item.detail === event.detail &&
          Math.abs(item.ts - event.ts) < 60_000
        )));
        if (!freshEvents.length) return current;
        freshEvents
          .filter((event) => event.severity === "critical" || event.severity === "warn" || event.title.includes("已恢复"))
          .slice(0, 3)
          .forEach((event) => {
            void fetch("/api/notifications/event", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: event.title, message: event.detail, severity: event.severity, key: `${event.source}:${event.title}` })
            }).catch(() => undefined);
          });
        const merged = [...freshEvents, ...current].slice(0, 80);
        writeRuntimeEvents(merged);
        return merged;
      });
    }
    previousStatusRef.current = nextStatus;
    previousDiagnosticsRef.current = nextDiagnostics;
  }

  async function readRuntime(signal?: AbortSignal) {
    const response = await fetch("/api/runtime", { signal });
    if (!response.ok) throw new Error("runtime request failed");
    return response.json() as Promise<RuntimePayload>;
  }

  const refreshRuntime = useCallback(async () => {
    if (runtimeLoadingRef.current) return;
    runtimeLoadingRef.current = true;
    try {
      applyRuntime(await readRuntime());
    } finally {
      runtimeLoadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    let active = true;
    let runtimeController: AbortController | null = null;

    async function loadRuntime() {
      if (runtimeLoadingRef.current) return;
      runtimeLoadingRef.current = true;
      runtimeController = new AbortController();
      try {
        const runtime = await readRuntime(runtimeController.signal);
        if (!active) {
          runtimeLoadingRef.current = false;
          return;
        }
        applyRuntime(runtime);
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) {
          runtimeLoadingRef.current = false;
          return;
        }
        fetch("/config.json")
          .then((response) => {
            if (!response.ok) throw new Error("config request failed");
            return response.json() as Promise<AppConfig>;
          })
          .then((nextConfig) => {
            if (active) setConfig(hasLocalConfig() ? readLocalConfig() : nextConfig);
          })
          .catch(() => {
              if (active) setConfig(fallbackConfig);
            });
      }
      runtimeLoadingRef.current = false;
    }

    loadRuntime();
    const runtimeTimer = window.setInterval(loadRuntime, 5000);

    fetch("/api/connections")
      .then((response) => {
        if (!response.ok) throw new Error("connections request failed");
        return response.json() as Promise<ConnectionSettings>;
      })
      .then((nextConnections) => {
        if (active) setConnections(nextConnections);
      })
      .catch(() => {
        if (active) setConnections(emptyConnections);
      });

    return () => {
      active = false;
      runtimeController?.abort();
      window.clearInterval(runtimeTimer);
    };
  }, []);

  async function addBookmark(bookmark: Bookmark) {
    try {
      const response = await fetch("/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bookmark)
      });
      if (!response.ok) throw new Error("bookmark save failed");
      const saved = (await response.json()) as Bookmark;
      setCustomBookmarks((current) => [saved, ...current.filter((item) => item.url !== saved.url)].slice(0, 80));
      return;
    } catch {
      setCustomBookmarks((current) => {
        const next = [bookmark, ...current.filter((item) => item.url !== bookmark.url)].slice(0, 12);
        writeLocalBookmarks(next);
        return next;
      });
    }
  }

  async function updateBookmark(originalUrl: string, bookmark: Bookmark) {
    const normalizedOriginal = normalizeUrl(originalUrl);
    await removeBookmark(normalizedOriginal);
    await addBookmark(bookmark);
  }

  async function importBookmarks(bookmarks: Bookmark[]) {
    for (const bookmark of bookmarks) {
      await addBookmark(bookmark);
    }
  }

  async function saveCustomBookmarks(nextBookmarks: Bookmark[]) {
    setCustomBookmarks(nextBookmarks);
    try {
      const response = await fetch("/api/bookmarks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookmarks: nextBookmarks })
      });
      if (!response.ok) throw new Error("bookmark bulk save failed");
      const payload = (await response.json()) as { bookmarks: Bookmark[] };
      setCustomBookmarks(payload.bookmarks);
      writeLocalBookmarks(payload.bookmarks);
    } catch {
      writeLocalBookmarks(nextBookmarks);
    }
  }

  async function removeBookmark(url: string) {
    const normalized = normalizeUrl(url);
    try {
      const response = await fetch("/api/bookmarks", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalized })
      });
      if (!response.ok) throw new Error("bookmark delete failed");
      const payload = (await response.json()) as { bookmarks: Bookmark[] };
      setCustomBookmarks(payload.bookmarks);
      writeLocalBookmarks(payload.bookmarks);
      return;
    } catch {
      setCustomBookmarks((current) => {
        const next = current.filter((item) => normalizeUrl(item.url) !== normalized);
        writeLocalBookmarks(next);
        return next;
      });
    }
  }

  async function resetCustomBookmarks() {
    try {
      await fetch("/api/bookmarks/all", { method: "DELETE" });
    } catch {
      // Static preview mode falls back to local storage.
    }
    setCustomBookmarks([]);
    writeLocalBookmarks([]);
  }

  async function updateConfig(nextConfig: AppConfig) {
    setConfig(nextConfig);
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextConfig)
      });
      if (!response.ok) throw new Error("config save failed");
      setConfig((await response.json()) as AppConfig);
    } catch {
      window.localStorage.setItem(localConfigKey, JSON.stringify(nextConfig));
    }
  }

  async function organizeBookmarks(nextBookmarks: Bookmark[], nextCategories = config.categories) {
    if (!config.bookmarks.length) {
      throw new Error("默认书签数据异常，已停止保存以避免清空左侧书签。");
    }
    const defaultUrlSet = new Set(config.bookmarks.map((bookmark) => bookmarkKey(bookmark.url)));
    const nextConfigBookmarks = nextBookmarks.filter((bookmark) => defaultUrlSet.has(bookmarkKey(bookmark.url)));
    const nextCustomBookmarks = nextBookmarks.filter((bookmark) => !defaultUrlSet.has(bookmarkKey(bookmark.url)));
    if (!nextConfigBookmarks.length) {
      throw new Error("本次整理没有包含默认书签，已停止保存。");
    }
    await Promise.all([
      updateConfig({
        ...config,
        categories: nextCategories,
        bookmarks: nextConfigBookmarks,
        bookmarkOrder: nextBookmarks.map((bookmark) => bookmark.url)
      }),
      saveCustomBookmarks(nextCustomBookmarks)
    ]);
  }

  async function syncWebContainerBookmarks() {
    const response = await fetch("/api/bookmarks/sync-web-containers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "NAS" })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = (await response.json()) as SyncWebBookmarksPayload;
    setCustomBookmarks(payload.bookmarks);
    setConfig(payload.config);
    writeLocalBookmarks(payload.bookmarks);
    return payload;
  }

  async function createBackup() {
    try {
      const response = await fetch("/api/backup");
      if (!response.ok) throw new Error("backup request failed");
      const backup = await response.json();
      downloadJson(`hometab-backup-${new Date().toISOString().slice(0, 10)}.json`, backup);
      return "备份已导出。";
    } catch {
      downloadJson(`hometab-backup-${new Date().toISOString().slice(0, 10)}.json`, {
        version: 1,
        exportedAt: new Date().toISOString(),
        config,
        customBookmarks
      });
      return "已导出本地备份。";
    }
  }

  async function restoreBackup(backup: BackupPayload) {
    if (!backup.config || !Array.isArray(backup.customBookmarks)) throw new Error("备份文件格式不正确");

    try {
      const response = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(backup)
      });
      if (!response.ok) throw new Error("backup import failed");
    } catch {
      window.localStorage.setItem(localConfigKey, JSON.stringify(backup.config));
      writeLocalBookmarks(backup.customBookmarks);
    }

    setConfig(backup.config);
    setCustomBookmarks(backup.customBookmarks);
  }

  async function importBackup(file: File) {
    await restoreBackup(JSON.parse(await file.text()) as BackupPayload);
  }

  async function updateConnections(nextConnections: ConnectionSettings) {
    setConnections(nextConnections);
    const response = await fetch("/api/connections", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextConnections)
    });
    if (!response.ok) throw new Error("connections save failed");
  }

  function clearEvents() {
    setEvents([]);
    writeRuntimeEvents([]);
  }

  function addAuditEvent(title: string, detail: string, severity: EventSeverity = "info") {
    const event: RuntimeEvent = {
      id: `${Date.now()}-audit-${Math.random().toString(16).slice(2)}`,
      ts: Date.now(),
      title,
      detail,
      severity,
      source: "Audit"
    };
    setEvents((current) => {
      const merged = [event, ...current].slice(0, 80);
      writeRuntimeEvents(merged);
      return merged;
    });
  }

  function updateAlertRules(nextRules: AlertRules) {
    const normalized = normalizeAlertRules(nextRules);
    setAlertRules(normalized);
    alertRulesRef.current = normalized;
    writeAlertRules(normalized);
    eventSignalsRef.current = {};
  }

  return {
    config,
    customBookmarks,
    status,
    history,
    connections,
    lastRefreshAt,
    diagnostics,
    events,
    alertRules,
    refreshRuntime,
    addBookmark,
    updateBookmark,
    importBookmarks,
    removeBookmark,
    resetCustomBookmarks,
    updateConfig,
    organizeBookmarks,
    syncWebContainerBookmarks,
    updateConnections,
    createBackup,
    restoreBackup,
    importBackup,
    clearEvents,
    addAuditEvent,
    updateAlertRules
  };
}

function Clock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(now);

  const date = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(now);

  return (
    <header className="hero-time" aria-label="时间">
      <div className="hero-time__time">{time}</div>
      <div className="hero-time__date">{date}</div>
    </header>
  );
}

function TopBar({
  searchQuery,
  onSearchChange,
  onSearchSubmit,
  theme,
  onThemeChange,
  status,
  lastRefreshAt
}: {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onSearchSubmit: () => void;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  status: RuntimeStatus;
  lastRefreshAt: string;
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now);

  const running = status.docker?.running ?? 0;
  const total = status.docker?.total ?? 0;

  return (
    <header className="topbar" aria-label="首页工具栏">
      <div className="topbar__title">
        <span>首页</span>
        <small>HomeTab Pilot</small>
      </div>
      <SearchBar value={searchQuery} onChange={onSearchChange} onSubmit={onSearchSubmit} />
      <div className="topbar__right">
        <div className="theme-switch" aria-label="主题切换">
          {themeOptions.map((option) => (
            <button
              className={theme === option.id ? "theme-dot theme-dot--active" : "theme-dot"}
              key={option.id}
              type="button"
              title={option.name}
              onClick={() => onThemeChange(option.id)}
            >
              {option.tone}
            </button>
          ))}
        </div>
        <span className="status-pill status-pill--network">
          <UiIcon name="network" />
          5s 实时
        </span>
        <span className="status-pill">
          <UiIcon name="refresh" />
          {formatRefreshTime(lastRefreshAt)}
        </span>
        <span className="status-pill">
          <UiIcon name="clock" />
          {time}
        </span>
        <span className="status-pill status-pill--runtime">
          <UiIcon name="server" />
          {running}/{total || "-"} 容器
        </span>
      </div>
    </header>
  );
}

function Sidebar({
  onHome,
  onBookmarks,
  onAdd,
  onImport,
  onWallpaper,
  onSettings,
  onBackup
}: {
  onHome: () => void;
  onBookmarks: () => void;
  onAdd: () => void;
  onImport: () => void;
  onWallpaper: () => void;
  onSettings: () => void;
  onBackup: () => void;
}) {
  const actions = [onHome, onBookmarks, onAdd, onImport, onWallpaper, onSettings, onBackup];

  return (
    <aside className="sidebar" aria-label="主导航">
      <div className="logo">HP</div>
      <nav className="sidebar__nav">
        {navItems.map((item, index) => (
          <button
            aria-label={item.label}
            className={index === 0 ? "nav-button nav-button--active" : "nav-button"}
            key={item.label}
            type="button"
            onClick={actions[index]}
          >
            <UiIcon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <span className="sidebar__hint">右键编辑书签</span>
    </aside>
  );
}

function SearchBar({
  value,
  onChange,
  onSubmit
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="search-bar"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <UiIcon name="search" />
      <input
        aria-label="搜索网站、服务或命令"
        placeholder="搜索网站、服务或命令"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="submit" aria-label="搜索或打开">
        <kbd>↵</kbd>
      </button>
    </form>
  );
}

function CategoryTabs({
  categories,
  activeCategory,
  onSelect
}: {
  categories: string[];
  activeCategory: string;
  onSelect: (category: string) => void;
}) {
  return (
    <div className="tabs" aria-label="书签分类">
      {categories.map((category, index) => (
        <button
          className={category === activeCategory ? "tab tab--active" : "tab"}
          key={category}
          type="button"
          onClick={() => onSelect(category)}
        >
          {category}
        </button>
      ))}
      <button className={!activeCategory ? "tab-menu tab-menu--active" : "tab-menu"} type="button" aria-label="显示全部分类" onClick={() => onSelect("")}>
        <UiIcon name="menu" />
      </button>
    </div>
  );
}

function LogoImage({
  bookmark,
  size = "large",
  onResolved
}: {
  bookmark: Pick<Bookmark, "name" | "url" | "icon" | "logoUrl" | "color">;
  size?: "large" | "small";
  onResolved?: (src: string) => void;
}) {
  const candidates = getLogoCandidates(bookmark);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const src = candidates[index];

  useEffect(() => {
    setIndex(0);
    setFailed(false);
  }, [bookmark.logoUrl, bookmark.url]);

  if (!src || failed) {
    return <span className={`logo-fallback logo-fallback--${size}`}>{bookmark.icon || bookmark.name.slice(0, 1)}</span>;
  }

  return (
    <span className={`logo-frame logo-frame--${size}`}>
      <img
        alt={`${bookmark.name} Logo`}
        decoding="async"
        loading="lazy"
        src={src}
        onError={() => {
          setIndex((nextIndex) => {
            if (nextIndex + 1 < candidates.length) return nextIndex + 1;
            setFailed(true);
            return nextIndex;
          });
        }}
        onLoad={() => onResolved?.(src)}
      />
    </span>
  );
}

function BrandLogo({
  name,
  size = "large"
}: {
  name: string;
  size?: "large" | "small";
}) {
  const icon = brandIconMap[name as keyof typeof brandIconMap];

  if (!icon) return null;

  return (
    <span className={`brand-logo brand-logo--${size}`} style={{ color: `#${icon.hex}` }}>
      <svg viewBox="0 0 24 24" aria-label={`${name} Logo`}>
        <path d={icon.path} fill="currentColor" />
      </svg>
    </span>
  );
}

function BookmarkLogo({
  bookmark,
  size = "large",
  onResolved
}: {
  bookmark: Pick<Bookmark, "name" | "url" | "icon" | "logoUrl" | "color">;
  size?: "large" | "small";
  onResolved?: (src: string) => void;
}) {
  if (brandIconMap[bookmark.name as keyof typeof brandIconMap]) {
    return <BrandLogo name={bookmark.name} size={size} />;
  }

  return <LogoImage bookmark={bookmark} size={size} onResolved={onResolved} />;
}

function BookmarkBoard({
  config,
  bookmarks,
  activeCategory,
  searchQuery,
  onCategorySelect,
  onAddClick,
  onEditBookmark,
  onRemoveBookmark,
  onRemoveBookmarks,
  onReorderBookmarks,
  onMoveBookmarks
}: {
  config: AppConfig;
  bookmarks: Bookmark[];
  activeCategory: string;
  searchQuery: string;
  onCategorySelect: (category: string) => void;
  onAddClick: () => void;
  onEditBookmark: (bookmark: Bookmark) => void;
  onRemoveBookmark: (url: string) => void;
  onRemoveBookmarks: (urls: string[]) => void;
  onReorderBookmarks: (bookmarks: Bookmark[]) => void;
  onMoveBookmarks: (urls: string[], category: string) => void;
}) {
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedUrls, setSelectedUrls] = useState<string[]>([]);
  const [moveCategory, setMoveCategory] = useState(activeCategory || config.categories[0] || "常用");
  const [draggingUrl, setDraggingUrl] = useState("");
  const query = searchQuery.trim().toLowerCase();
  const visibleBookmarks = bookmarks
    .filter((bookmark) => !activeCategory || bookmark.category === activeCategory)
    .filter((bookmark) => {
      if (!query) return true;
      return `${bookmark.name} ${bookmark.url} ${bookmark.category}`.toLowerCase().includes(query);
    });
  const defaultUrls = new Set(config.bookmarks.map((bookmark) => normalizeUrl(bookmark.url)));
  const removableSelected = selectedUrls.filter((url) => !defaultUrls.has(normalizeUrl(url)));
  const selectedCount = selectedUrls.length;

  useEffect(() => {
    if (!config.categories.includes(moveCategory)) {
      setMoveCategory(activeCategory || config.categories[0] || "常用");
    }
  }, [activeCategory, config.categories, moveCategory]);

  function toggleSelected(url: string) {
    setSelectedUrls((current) => current.includes(url) ? current.filter((item) => item !== url) : [...current, url]);
  }

  function closeBulkMode() {
    setBulkMode(false);
    setSelectedUrls([]);
  }

  function reorderVisible(sourceUrl: string, targetUrl: string) {
    if (sourceUrl === targetUrl) return;
    const fromIndex = bookmarks.findIndex((bookmark) => bookmark.url === sourceUrl);
    const toIndex = bookmarks.findIndex((bookmark) => bookmark.url === targetUrl);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextBookmarks = [...bookmarks];
    const [moved] = nextBookmarks.splice(fromIndex, 1);
    const nextTargetIndex = nextBookmarks.findIndex((bookmark) => bookmark.url === targetUrl);
    nextBookmarks.splice(nextTargetIndex, 0, moved);
    onReorderBookmarks(nextBookmarks);
  }

  return (
    <section className="bookmark-board" aria-label="书签导航">
      <div className="board-head">
        <div>
          <span className="eyebrow">书签</span>
          <h1>常用入口</h1>
        </div>
        <button className="board-head__add" type="button" onClick={onAddClick}>
          <UiIcon name="plusCircle" />
          添加
        </button>
      </div>
      <div className="bookmark-bulkbar">
        <button type="button" onClick={() => (bulkMode ? closeBulkMode() : setBulkMode(true))}>
          {bulkMode ? "退出批量" : "批量管理"}
        </button>
        {bulkMode ? (
          <>
            <span>已选 {selectedCount} 个</span>
            <label className="bookmark-move-select">
              移动到
              <select value={moveCategory} onChange={(event) => setMoveCategory(event.target.value)}>
                {config.categories.map((category) => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
            </label>
            <button type="button" disabled={!selectedCount} onClick={() => {
              onMoveBookmarks(selectedUrls, moveCategory);
              closeBulkMode();
            }}>
              移动分类
            </button>
            <button type="button" disabled={!removableSelected.length} onClick={() => {
              onRemoveBookmarks(removableSelected);
              closeBulkMode();
            }}>
              删除自定义
            </button>
          </>
        ) : null}
      </div>
      <CategoryTabs categories={config.categories} activeCategory={activeCategory} onSelect={onCategorySelect} />
      <div className="bookmark-grid">
        {visibleBookmarks.slice(0, 17).map((bookmark) => (
          <article
            className={draggingUrl === bookmark.url ? "bookmark-card bookmark-card--dragging" : "bookmark-card"}
            key={`${bookmark.name}-${bookmark.url}`}
            role="link"
            tabIndex={0}
            draggable={!bulkMode}
            onClick={() => (bulkMode ? toggleSelected(bookmark.url) : openUrl(bookmark.url))}
            onDragStart={(event) => {
              if (bulkMode) {
                event.preventDefault();
                return;
              }
              setDraggingUrl(bookmark.url);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", bookmark.url);
            }}
            onDragOver={(event) => {
              if (!bulkMode && draggingUrl && draggingUrl !== bookmark.url) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const sourceUrl = event.dataTransfer.getData("text/plain") || draggingUrl;
              setDraggingUrl("");
              reorderVisible(sourceUrl, bookmark.url);
            }}
            onDragEnd={() => setDraggingUrl("")}
            onContextMenu={(event) => {
              event.preventDefault();
              onEditBookmark(bookmark);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") openUrl(bookmark.url);
            }}
          >
            {bulkMode ? (
              <button
                className={selectedUrls.includes(bookmark.url) ? "bookmark-select bookmark-select--active" : "bookmark-select"}
                type="button"
                aria-label={`选择 ${bookmark.name}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleSelected(bookmark.url);
                }}
              >
                {selectedUrls.includes(bookmark.url) ? "✓" : ""}
              </button>
            ) : null}
            {bookmark.status ? <i className={`status-dot status-dot--${bookmark.status}`} /> : null}
            {!config.bookmarks.some((item) => item.url === bookmark.url) ? (
              <button
                className="bookmark-delete"
                type="button"
                aria-label={`删除 ${bookmark.name}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onRemoveBookmark(bookmark.url);
                }}
              >
                ×
              </button>
            ) : null}
            <button
              className="bookmark-edit"
              type="button"
              aria-label={`编辑 ${bookmark.name}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onEditBookmark(bookmark);
              }}
            >
              <UiIcon name="settings" />
            </button>
            <BookmarkLogo bookmark={bookmark} />
            <span>{bookmark.name}</span>
          </article>
        ))}
        <button className="bookmark-card bookmark-card--add" type="button" onClick={onAddClick}>
          <span className="add-mark">＋</span>
          <span>添加</span>
        </button>
      </div>
    </section>
  );
}

function SystemCards({
  config,
  status,
  history,
  diagnostics,
  events,
  lastRefreshAt,
  onRefreshRuntime,
  onSyncWebBookmarks,
  authToken,
  authStatus,
  onRequireAuth,
  onAuthExpired,
  onClearEvents,
  onAuditEvent,
  onNotice
}: {
  config: AppConfig;
  status: RuntimeStatus;
  history: RuntimeHistory;
  diagnostics: DiagnosticCheck[];
  events: RuntimeEvent[];
  lastRefreshAt: string;
  onRefreshRuntime: () => Promise<void>;
  onSyncWebBookmarks: () => Promise<SyncWebBookmarksPayload>;
  authToken: string;
  authStatus: AuthStatus;
  onRequireAuth: () => boolean;
  onAuthExpired: () => void;
  onClearEvents: () => void;
  onAuditEvent: (title: string, detail: string, severity?: EventSeverity) => void;
  onNotice: (message: string) => void;
}) {
  const [selectedContainerId, setSelectedContainerId] = useState("");
  const [logContainer, setLogContainer] = useState<DockerService | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [containerDetail, setContainerDetail] = useState<Record<string, unknown> | null>(null);
  const [configLoadingContainer, setConfigLoadingContainer] = useState<DockerService | null>(null);
  const [pendingContainerAction, setPendingContainerAction] = useState<{ action: "stop" | "restart"; label: string; container: DockerService } | null>(null);
  const [pendingPveAction, setPendingPveAction] = useState<{ action: PveAction; label: string; vm: PveVm } | null>(null);
  const [executingAction, setExecutingAction] = useState("");
  const [syncingWebBookmarks, setSyncingWebBookmarks] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");
  const [updateReports, setUpdateReports] = useState<Record<string, DockerUpdateReport>>({});
  const [undoState, setUndoState] = useState<{ token: string; label: string; expiresAt: string } | null>(null);
  const [containerSearch, setContainerSearch] = useState("");
  const [containerStateFilter, setContainerStateFilter] = useState<"all" | "running" | "stopped" | "updates">("all");
  const [pinnedContainers, setPinnedContainers] = useState<string[]>(() => {
    try {
      return JSON.parse(window.localStorage.getItem("hometab.pinnedContainers.v1") || "[]") as string[];
    } catch {
      return [];
    }
  });
  const [pveActionMessage, setPveActionMessage] = useState("");
  const fnos = status.fnos || {
    available: true,
    status: config.systems.fnos.status,
    storage: config.systems.fnos.storage,
    cpu: config.systems.fnos.cpu,
    memory: config.systems.fnos.memory
  };
  const pveVmCount = status.pve?.vms?.length || config.systems.pve.vms;
  const pveChips = status.pve?.vms?.slice(0, 3).map((vm) => vm.name || String(vm.vmid)) || config.systems.pve.chips;
  const pveStatus = status.pve?.available ? `${status.pve.node} 在线` : config.systems.pve.status;
  const pveCpu = status.pve?.cpu ?? Math.min(100, 18 + pveVmCount * 2);
  const pveMemory = status.pve?.memory ?? Math.min(100, 28 + pveVmCount * 3);
  const pveStorage = status.pve?.storage ?? Math.min(100, pveVmCount * 10);
  const fallbackContainers: DockerService[] = config.systems.containers.services.map((service) => ({
    id: "",
    name: service,
    image: "unknown",
    state: "running",
    status: "running",
    accessUrls: []
  }));
  const containers = status.docker?.services || fallbackContainers;
  const filteredContainers = containers
    .filter((container) => {
      const query = containerSearch.trim().toLowerCase();
      const text = `${container.name} ${container.image} ${container.state}`.toLowerCase();
      if (query && !text.includes(query)) return false;
      if (containerStateFilter === "running" && container.state !== "running") return false;
      if (containerStateFilter === "stopped" && container.state === "running") return false;
      if (containerStateFilter === "updates" && !updateReports[container.id]?.hasUpdate) return false;
      return true;
    })
    .sort((a, b) => Number(pinnedContainers.includes(b.id)) - Number(pinnedContainers.includes(a.id)) || a.name.localeCompare(b.name));
  const runningContainers = status.docker?.available ? status.docker.running : config.systems.containers.running;
  const selectedContainer = containers.find((container) => container.id === selectedContainerId) || filteredContainers[0] || containers[0];
  const selectedContainerKey = selectedContainer?.id || selectedContainer?.name || "";
  const selectedContainerHistory = selectedContainerKey ? history.containers[selectedContainerKey] : undefined;
  const fnosBookmark = config.bookmarks.find((bookmark) => bookmark.name === "飞牛OS");
  const pveBookmark = config.bookmarks.find((bookmark) => bookmark.name === "PVE");
  const pveVms = status.pve?.vms || [];
  const dockerOperations = events.filter((event) => event.source === "Audit" && event.title.startsWith("Docker")).slice(0, 5);
  const webContainerCount = containers.filter((container) => container.accessUrls?.length).length;
  const webReachableCount = containers.filter((container) => container.accessUrls?.some((access) => access.webStatus === "ok")).length;

  function selectContainer(container: DockerService) {
    if (container.id) setSelectedContainerId(container.id);
  }

  function togglePinnedContainer(container: DockerService) {
    if (!container.id) return;
    setPinnedContainers((current) => {
      const next = current.includes(container.id) ? current.filter((id) => id !== container.id) : [container.id, ...current].slice(0, 12);
      window.localStorage.setItem("hometab.pinnedContainers.v1", JSON.stringify(next));
      return next;
    });
  }

  async function showContainerLogs(container = selectedContainer) {
    selectContainer(container);
    if (!container?.id) {
      setActionMessage("当前没有可读取的真实容器。");
      return;
    }

    onAuditEvent("查看 Docker 日志", `${container.name} · ${container.image || "unknown"}`);
    setLogContainer(container);
  }

  function requestPveAction(action: PveAction, label: string, vm: PveVm) {
    setPendingPveAction({ action, label, vm });
  }

  async function runPveAction(action: PveAction, label: string, vm: PveVm) {
    if (!onRequireAuth()) return;
    const node = vm.node || status.pve?.node;
    const type = vm.type === "lxc" ? "lxc" : "qemu";
    if (!node || !vm.vmid) {
      setPveActionMessage("当前没有可操作的 PVE 节点或 VMID。");
      return;
    }

    setExecutingAction(`pve:${action}:${vm.vmid}`);
    onAuditEvent(`PVE ${label}已提交`, `${vm.name || vm.vmid} · ${type.toUpperCase()} ${vm.vmid}`);
    try {
      const response = await fetch(`/api/pve/${encodeURIComponent(node)}/${type}/${encodeURIComponent(vm.vmid)}/${action}`, {
        method: "POST",
        headers: authHeaders(authToken)
      });
      const text = await response.text();
      if (response.ok) {
        const message = `已向 ${vm.name || vm.vmid} 发送${label}指令，正在刷新状态。`;
        setPveActionMessage(message);
        onNotice(message);
        onAuditEvent(`PVE ${label}成功`, `${vm.name || vm.vmid} · 指令已发送`);
        await onRefreshRuntime();
      } else {
        if (response.status === 401) onAuthExpired();
        setPveActionMessage(`${label}失败：${text}`);
        onAuditEvent(`PVE ${label}失败`, `${vm.name || vm.vmid} · ${text}`, "warn");
      }
    } catch {
      setPveActionMessage(`当前页面没有连接到后端 API，无法${label} PVE 实例。`);
      onAuditEvent(`PVE ${label}失败`, `${vm.name || vm.vmid} · 后端 API 不可用`, "warn");
    } finally {
      setExecutingAction("");
      setPendingPveAction(null);
    }
  }

  async function requestContainerAction(action: "start" | "stop" | "restart", label: string, container = selectedContainer) {
    selectContainer(container);
    if (action === "stop" || action === "restart") {
      await runUpdateAction("preview", container);
      setPendingContainerAction({ action, label, container });
      return;
    }
    void runContainerAction(action, label, container);
  }

  async function runContainerAction(action: "start" | "stop" | "restart", label: string, container = selectedContainer) {
    if (!onRequireAuth()) return;
    if (!container?.id) {
      setActionMessage(`当前没有可${label}的真实容器。`);
      return;
    }

    setExecutingAction(`${action}:${container.id}`);
    onAuditEvent(`Docker ${label}已提交`, `${container.name} · ${container.image || "unknown"}`);
    try {
      const response = await fetch(`/api/docker/containers/${encodeURIComponent(container.id)}/${action}`, {
        method: "POST",
        headers: authHeaders(authToken)
      });
      const text = await response.text();
      if (response.ok) {
        const payload = text ? JSON.parse(text) as { undo?: { token: string; expiresAt: string } } : {};
        if (payload.undo?.token) setUndoState({ token: payload.undo.token, label: `撤销${label}`, expiresAt: payload.undo.expiresAt });
        const message = `已${label} ${container.name}，正在刷新状态。${payload.undo ? " 可在撤销窗口内恢复。" : ""}`;
        setActionMessage(message);
        onNotice(message);
        onAuditEvent(`Docker ${label}成功`, `${container.name} · 指令已执行`);
        await onRefreshRuntime();
      } else {
        if (response.status === 401) onAuthExpired();
        setActionMessage(`${label}失败：${text}`);
        onAuditEvent(`Docker ${label}失败`, `${container.name} · ${text}`, "warn");
      }
    } catch {
      setActionMessage(`当前页面没有连接到后端 API，无法${label}真实容器。`);
      onAuditEvent(`Docker ${label}失败`, `${container.name} · 后端 API 不可用`, "warn");
    } finally {
      setExecutingAction("");
      setPendingContainerAction(null);
    }
  }

  async function showContainerConfig(container = selectedContainer) {
    selectContainer(container);
    if (!container?.id) {
      setActionMessage("当前没有可查看配置的真实容器。");
      return;
    }
    onAuditEvent("查看 Docker 配置", `${container.name} · ${container.image || "unknown"}`);
    setActionMessage(`正在读取 ${container.name} 的 Docker 配置...`);
    setConfigLoadingContainer(container);
    try {
      const response = await fetch(`/api/docker/containers/${encodeURIComponent(container.id)}`);
      if (!response.ok) throw new Error(await response.text());
      setContainerDetail((await response.json()) as Record<string, unknown>);
      setActionMessage("");
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "配置读取失败。");
    } finally {
      setConfigLoadingContainer(null);
    }
  }

  async function undoLastOperation() {
    if (!undoState || !onRequireAuth()) return;
    setExecutingAction(`undo:${undoState.token}`);
    try {
      const response = await fetch(`/api/docker/undo/${encodeURIComponent(undoState.token)}`, { method: "POST", headers: authHeaders(authToken) });
      if (!response.ok) throw new Error(await response.text());
      setActionMessage("撤销操作已执行，正在刷新状态。");
      setUndoState(null);
      await onRefreshRuntime();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "撤销失败。");
    } finally {
      setExecutingAction("");
    }
  }

  async function runUpdateAction(action: "preview" | "update" | "pull" | "recreate" | "rollback", container = selectedContainer) {
    if (!container?.id) return;
    if (action !== "update" && action !== "preview" && !onRequireAuth()) return;
    const endpoints = {
      preview: `/api/docker/containers/${encodeURIComponent(container.id)}/operation-preview`,
      update: `/api/docker/containers/${encodeURIComponent(container.id)}/update`,
      pull: `/api/docker/containers/${encodeURIComponent(container.id)}/pull`,
      recreate: `/api/docker/containers/${encodeURIComponent(container.id)}/recreate`,
      rollback: "/api/docker/backups"
    };
    setExecutingAction(`update:${action}:${container.id}`);
    try {
      const response = await fetch(endpoints[action], {
        method: action === "update" || action === "rollback" || action === "preview" ? "GET" : "POST",
        headers: authHeaders(authToken)
      });
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 401) onAuthExpired();
        throw new Error(text);
      }
      const payload = text ? JSON.parse(text) : {};
      if (action === "update") {
        setUpdateReports((current) => ({ ...current, [container.id]: payload as DockerUpdateReport }));
      }
      if (action === "preview") {
        setUpdateReports((current) => ({ ...current, [container.id]: { ...(current[container.id] || {}), id: container.id, image: container.image, safety: payload } as DockerUpdateReport }));
      }
      const message = action === "preview"
        ? `操作预览已生成：${payload.safe ? "可安全复原" : `存在风险 ${payload.risks?.join(", ") || "unknown"}`}。`
        : action === "update"
          ? `镜像 ${payload.image || container.image} 已检查：${payload.hasUpdate ? "发现更新" : "暂无更新"}，备份 ${payload.backups?.length || 0} 个。`
        : action === "pull"
          ? `已拉取 ${payload.image || container.image}。`
          : action === "recreate"
            ? `已重建 ${container.name}，备份 ${payload.backup || "已保存"}。`
            : `已有 ${payload.backups?.length || 0} 个容器备份可回滚。`;
      setUpdateMessage(message);
      onNotice(message);
      if (action !== "update" && action !== "rollback") await onRefreshRuntime();
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新中心操作失败。";
      setUpdateMessage(message);
      onNotice(message);
    } finally {
      setExecutingAction("");
    }
  }

  async function scanAllUpdates() {
    setExecutingAction("updates:scan");
    try {
      const response = await fetch("/api/docker/updates");
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json() as { reports: DockerUpdateReport[] };
      setUpdateReports(Object.fromEntries(payload.reports.map((report) => [report.id, report])));
      setUpdateMessage(`已检查 ${payload.reports.length} 个容器，${payload.reports.filter((report) => report.hasUpdate).length} 个发现更新。`);
    } catch (error) {
      setUpdateMessage(error instanceof Error ? error.message : "批量检查失败。");
    } finally {
      setExecutingAction("");
    }
  }

  async function bulkSafeUpdate() {
    if (!onRequireAuth()) return;
    const password = window.prompt("批量安全更新需要再次输入管理密码");
    if (!password) return;
    setExecutingAction("updates:bulk-safe");
    try {
      const response = await fetch("/api/docker/updates/bulk-safe", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(authToken) },
        body: JSON.stringify({ password })
      });
      if (response.status === 401 || response.status === 403) onAuthExpired();
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json() as { updated: number };
      setUpdateMessage(`已批量安全更新 ${payload.updated} 个容器。`);
      await onRefreshRuntime();
      await scanAllUpdates();
    } catch (error) {
      setUpdateMessage(error instanceof Error ? error.message : "批量安全更新失败。");
    } finally {
      setExecutingAction("");
    }
  }

  async function syncWebBookmarks() {
    setSyncingWebBookmarks(true);
    onAuditEvent("Docker Web书签同步已提交", `${webContainerCount} 个容器带访问地址`);
    try {
      const payload = await onSyncWebBookmarks();
      const message = `已同步 ${payload.synced} 个 Web 容器到 ${payload.category} 分组。`;
      setActionMessage(message);
      onNotice(message);
      onAuditEvent("Docker Web书签同步成功", message);
      await onRefreshRuntime();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Web 容器书签同步失败。";
      setActionMessage(message);
      onNotice(message);
      onAuditEvent("Docker Web书签同步失败", message, "warn");
    } finally {
      setSyncingWebBookmarks(false);
    }
  }

  return (
    <section className="ops-workbench" aria-label="系统管理">
      <div className="device-grid">
        <DeviceCard
          name="FNOS"
          subtitle={fnos.url || fnosBookmark?.url || "等待配置"}
          status={fnos.status}
          accent="teal"
          logo={<BookmarkLogo bookmark={{ name: "飞牛OS", url: "https://fnos.local", icon: "牛", color: "green", logoUrl: "https://www.fnnas.com/favicon.ico" }} size="small" />}
          metrics={[
            { label: "CPU", value: fnos.cpu, points: history.fnos.cpu },
            { label: "内存", value: fnos.memory, points: history.fnos.memory },
            { label: "存储", value: fnos.storage, points: history.fnos.storage }
          ]}
          footer={[fnos.available ? "SSH 已连通" : "等待连接", `Docker ${runningContainers} 个运行中`]}
          onOpen={() => (openUrl(fnos.url || fnosBookmark?.url) ? undefined : onNotice("飞牛 OS 地址未配置。"))}
        />
        <DeviceCard
          name="PVE"
          subtitle={pveBookmark?.url || "等待配置"}
          status={pveStatus}
          accent="orange"
          logo={<BookmarkLogo bookmark={{ name: "PVE", url: "https://pve.local", icon: "P", color: "blue", logoUrl: "https://www.proxmox.com/favicon.ico" }} size="small" />}
          metrics={[
            { label: "CPU", value: pveCpu, points: history.pve.cpu },
            { label: "内存", value: pveMemory, points: history.pve.memory },
            { label: "存储", value: pveStorage, points: history.pve.storage }
          ]}
          footer={[`${pveVmCount} 台 VM/LXC`, pveChips.join(" / ")]}
          onOpen={() => (openUrl(pveBookmark?.url) ? undefined : onNotice("PVE 控制台地址未配置。"))}
        />
      </div>

      <DiagnosticsPanel diagnostics={diagnostics} lastRefreshAt={lastRefreshAt} onRefresh={onRefreshRuntime} />

      <EventCenterPanel events={events} onClear={onClearEvents} />

      <PveManagerPanel
        available={Boolean(status.pve?.available)}
        node={status.pve?.node || ""}
        vms={pveVms}
        message={pveActionMessage}
        busyAction={executingAction}
        onAction={requestPveAction}
      />

      <article className="docker-board">
        <div className="docker-board__head">
          <div>
            <span className="eyebrow">Docker</span>
            <h2>容器管理</h2>
          </div>
          <div className="docker-summary">
            <span><i />运行中 {runningContainers}</span>
            <span>总数 {status.docker?.total ?? containers.length}</span>
            <span>Web {webReachableCount}/{webContainerCount}</span>
          </div>
        </div>
        {status.docker?.error ? <p className="action-message">{status.docker.error}</p> : null}
        <div className="docker-tools">
          <button type="button" disabled={syncingWebBookmarks || !webContainerCount} onClick={syncWebBookmarks}>
            <UiIcon name="bookmark" />
            {syncingWebBookmarks ? "同步中" : "同步Web书签到NAS"}
          </button>
          <button type="button" disabled={Boolean(executingAction)} onClick={() => void scanAllUpdates()}>
            <UiIcon name="search" />
            检查全部更新
          </button>
          <button type="button" disabled={Boolean(executingAction)} onClick={() => void bulkSafeUpdate()}>
            <UiIcon name="refresh" />
            一键安全更新
          </button>
          <span>{webContainerCount ? `发现 ${webContainerCount} 个带访问地址的容器` : "暂无可同步 Web 容器"}</span>
        </div>
        <div className="ops-filterbar">
          <input value={containerSearch} onChange={(event) => setContainerSearch(event.target.value)} placeholder="搜索容器、镜像、状态" />
          {(["all", "running", "stopped", "updates"] as const).map((item) => (
            <button type="button" key={item} className={containerStateFilter === item ? "is-active" : ""} onClick={() => setContainerStateFilter(item)}>
              {item === "all" ? "全部" : item === "running" ? "运行中" : item === "stopped" ? "已停止" : "有更新"}
            </button>
          ))}
        </div>
        <DockerOperationHistory events={dockerOperations} />

        <div className="container-table" role="table" aria-label="飞牛 OS Docker 容器列表">
          <div className="container-table__row container-table__row--head" role="row">
            <span>状态</span>
            <span>容器名称</span>
            <span>CPU</span>
            <span>内存</span>
            <span>访问</span>
            <span>操作</span>
          </div>
          {filteredContainers.map((service, index) => {
            const isSelected = selectedContainer?.name === service.name;
            const firstUrl = service.accessUrls?.[0]?.url;
            const report = updateReports[service.id];
            return (
              <div
                className={isSelected ? "container-table__row container-table__row--active" : "container-table__row"}
                key={service.id || service.name}
                role="row"
              >
                <span className={`run-state run-state--${service.state === "running" ? "running" : "stopped"}`} />
                <button className="container-name container-name-button" type="button" onClick={() => selectContainer(service)}>
                  {service.name || `container-${index + 1}`}
                  {service.health ? <small className={`health-chip health-chip--${service.health}`}>{healthText(service.health)}</small> : null}
                  {report?.hasUpdate ? <small className="health-chip health-chip--update">有更新</small> : null}
                  {pinnedContainers.includes(service.id) ? <small className="health-chip">置顶</small> : null}
                </button>
                <ResourceMeter className="resource-meter--cpu" value={readPercent(service.cpu)} label={service.cpu || "0%"} />
                <ResourceMeter className="resource-meter--memory" value={readPercent(service.memory)} label={service.memory || "0%"} />
                <span className={`visit-chip visit-chip--${service.accessUrls?.[0]?.webStatus || "unknown"}`} title={webStatusText(service.accessUrls?.[0]?.webStatus, service.accessUrls?.[0]?.httpStatus)}>
                  {service.accessUrls?.[0]?.hostPort || "-"}
                  {service.accessUrls?.[0]?.webStatus ? <small>{webStatusText(service.accessUrls[0].webStatus, service.accessUrls[0].httpStatus)}</small> : null}
                </span>
                <span className="row-actions">
                  <button type="button" aria-label={`打开 ${service.name} 访问地址`} disabled={!firstUrl || Boolean(executingAction)} onClick={() => openUrl(firstUrl)}>
                    <UiIcon name="open" />
                  </button>
                  <button type="button" aria-label={`查看 ${service.name} 日志`} disabled={!service.id || Boolean(executingAction)} onClick={() => showContainerLogs(service)}>
                    <UiIcon name="logs" />
                  </button>
                  <button type="button" aria-label={`查看 ${service.name} 配置`} disabled={!service.id || Boolean(executingAction) || Boolean(configLoadingContainer)} onClick={() => showContainerConfig(service)}>
                    <UiIcon name="settings" />
                  </button>
                  <button type="button" aria-label={`置顶 ${service.name}`} disabled={!service.id} onClick={() => togglePinnedContainer(service)}>
                    ↑
                  </button>
                </span>
              </div>
            );
          })}
        </div>

        {selectedContainer ? (
          <ContainerDetailPanel
            container={selectedContainer}
            actionMessage={actionMessage}
            history={selectedContainerHistory}
            isBusy={Boolean(executingAction) || Boolean(configLoadingContainer)}
            onLogs={() => showContainerLogs(selectedContainer)}
            onConfig={() => showContainerConfig(selectedContainer)}
            onToggle={() => requestContainerAction(selectedContainer.state === "running" ? "stop" : "start", selectedContainer.state === "running" ? "停止" : "启动", selectedContainer)}
            onRestart={() => requestContainerAction("restart", "重启", selectedContainer)}
            onUpdateCheck={() => runUpdateAction("update", selectedContainer)}
            onPullImage={() => runUpdateAction("pull", selectedContainer)}
            onRecreate={() => runUpdateAction("recreate", selectedContainer)}
            onRollbackList={() => runUpdateAction("rollback", selectedContainer)}
            updateMessage={updateMessage}
            updateReport={updateReports[selectedContainer.id]}
            undoState={undoState}
            onUndo={() => void undoLastOperation()}
          />
        ) : null}
        {pendingContainerAction ? (
          <ConfirmDialog
            title={`${pendingContainerAction.label}容器`}
            message={`确认要${pendingContainerAction.label} ${pendingContainerAction.container.name} 吗？这会直接作用于真实 Docker 容器。${updateReports[pendingContainerAction.container.id]?.safety?.summary ? ` 镜像：${updateReports[pendingContainerAction.container.id]?.safety?.summary.image}；挂载：${updateReports[pendingContainerAction.container.id]?.safety?.summary.mounts?.length || 0}；端口：${Object.keys(updateReports[pendingContainerAction.container.id]?.safety?.summary.ports || {}).length}；环境变量：${updateReports[pendingContainerAction.container.id]?.safety?.summary.env?.length || 0}。` : ""}`}
            confirmLabel={pendingContainerAction.label}
            busy={Boolean(executingAction)}
            onCancel={() => setPendingContainerAction(null)}
            onConfirm={() => runContainerAction(pendingContainerAction.action, pendingContainerAction.label, pendingContainerAction.container)}
          />
        ) : null}
        {pendingPveAction ? (
          <ConfirmDialog
            title={`${pendingPveAction.label} PVE 实例`}
            message={`确认要对 ${pendingPveAction.vm.name || pendingPveAction.vm.vmid} 执行${pendingPveAction.label}吗？这会直接作用于 PVE 上的真实 VM/LXC。`}
            confirmLabel={pendingPveAction.label}
            busy={Boolean(executingAction)}
            onCancel={() => setPendingPveAction(null)}
            onConfirm={() => runPveAction(pendingPveAction.action, pendingPveAction.label, pendingPveAction.vm)}
          />
        ) : null}
        {logContainer ? <ContainerLogsPanel container={logContainer} onClose={() => setLogContainer(null)} /> : null}
        {configLoadingContainer ? <LoadingDialog title="读取容器配置" message={`${configLoadingContainer.name} 正在通过飞牛 OS SSH 读取 Docker inspect 数据...`} /> : null}
        {containerDetail ? <ContainerConfigDialog detail={containerDetail} onClose={() => setContainerDetail(null)} /> : null}
      </article>
    </section>
  );
}

function EventCenterPanel({ events, onClear }: { events: RuntimeEvent[]; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const criticalCount = events.filter((event) => event.severity === "critical").length;
  const warnCount = events.filter((event) => event.severity === "warn").length;
  const latestEvents = events.slice(0, 3);

  return (
    <section className="event-center" aria-label="事件中心">
      <div className="event-center__head">
        <span className="eyebrow">Events</span>
        <b>事件中心</b>
        <small>{criticalCount} 严重 · {warnCount} 告警</small>
      </div>
      <div className="event-center__list">
        {latestEvents.length ? latestEvents.map((event) => (
          <button className={`event-pill event-pill--${event.severity}`} key={event.id} type="button" onClick={() => setOpen(true)}>
            <i />
            <strong>{event.title}</strong>
            <em>{eventTime(event.ts)}</em>
          </button>
        )) : (
          <span className="event-pill event-pill--empty">
            <i />
            <strong>暂无告警</strong>
            <em>等待采样</em>
          </span>
        )}
      </div>
      <button className="event-center__open" type="button" onClick={() => setOpen(true)}>
        <UiIcon name="logs" />
        全部
      </button>
      {open ? <EventCenterDialog events={events} onClear={onClear} onClose={() => setOpen(false)} /> : null}
    </section>
  );
}

function EventCenterDialog({ events, onClear, onClose }: { events: RuntimeEvent[]; onClear: () => void; onClose: () => void }) {
  const [filter, setFilter] = useState<"all" | EventSeverity | "audit">("all");
  const [auditFilter, setAuditFilter] = useState<"all" | "docker" | "pve" | "auth" | "notifications">("all");
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  useEffect(() => {
    const token = window.localStorage.getItem(authTokenKey) || "";
    fetch("/api/audit", { headers: authHeaders(token) })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("audit unavailable")))
      .then((payload: { events?: AuditEvent[] }) => setAuditEvents(Array.isArray(payload.events) ? payload.events : []))
      .catch(() => setAuditEvents([]));
  }, []);
  const visibleEvents = filter === "all"
    ? events
    : filter === "audit"
      ? events.filter((event) => event.source === "Audit")
      : events.filter((event) => event.severity === filter);
  const groupedEvents = visibleEvents.reduce<Array<{ label: string; events: RuntimeEvent[] }>>((groups, event) => {
    const label = eventDateLabel(event.ts);
    const last = groups[groups.length - 1];
    if (last?.label === label) {
      last.events.push(event);
    } else {
      groups.push({ label, events: [event] });
    }
    return groups;
  }, []);
  async function exportAudit() {
    const token = window.localStorage.getItem(authTokenKey) || "";
    const response = await fetch("/api/audit/export", { headers: authHeaders(token) });
    if (response.ok) {
      downloadText(`hometab-audit-${new Date().toISOString().slice(0, 10)}.json`, await response.text());
    } else {
      downloadJson(`hometab-local-events-${new Date().toISOString().slice(0, 10)}.json`, events);
    }
  }
  async function exportAuditCsv() {
    const token = window.localStorage.getItem(authTokenKey) || "";
    const response = await fetch("/api/audit/export.csv", { headers: authHeaders(token) });
    if (response.ok) downloadText(`hometab-audit-${new Date().toISOString().slice(0, 10)}.csv`, await response.text());
  }
  const visibleAuditEvents = auditEvents.filter((event) => auditFilter === "all" || String(event.action || "").startsWith(auditFilter === "notifications" ? "notifications" : auditFilter));

  return (
    <DialogShell className="utility-dialog utility-dialog--wide events-dialog" onClose={onClose}>
      <DialogHead title="事件中心" subtitle="基于 5 秒真实采样生成阈值告警、连接诊断和状态变化记录。" onClose={onClose} />
      <div className="events-toolbar">
        {(["all", "critical", "warn", "info", "audit"] as const).map((item) => (
          <button className={filter === item ? "events-filter events-filter--active" : "events-filter"} key={item} type="button" onClick={() => setFilter(item)}>
            {item === "all" ? "全部" : item === "critical" ? "严重" : item === "warn" ? "告警" : item === "audit" ? "审计" : "信息"}
          </button>
        ))}
        <button className="events-clear" type="button" disabled={!events.length} onClick={onClear}>
          清空记录
        </button>
        <button className="events-clear" type="button" onClick={() => void exportAudit()}>
          导出审计
        </button>
        <button className="events-clear" type="button" onClick={() => void exportAuditCsv()}>
          导出 CSV
        </button>
      </div>
      <div className="events-toolbar">
        {(["all", "docker", "pve", "auth", "notifications"] as const).map((item) => (
          <button className={auditFilter === item ? "events-filter events-filter--active" : "events-filter"} key={item} type="button" onClick={() => setAuditFilter(item)}>
            {item === "all" ? "全部审计" : item === "docker" ? "Docker" : item === "pve" ? "PVE" : item === "auth" ? "登录" : "通知"}
          </button>
        ))}
      </div>
      <div className="audit-table">
        {visibleAuditEvents.slice(0, 80).map((event) => (
          <article key={event.id} className={`event-row event-row--${event.severity || "info"}`}>
            <span>{event.result || "-"}</span>
            <div>
              <b>{event.action || "-"}</b>
              <small>{event.target || "-"} · {event.detail || ""}{event.error ? ` · ${event.error}` : ""}</small>
            </div>
            <time>{event.at ? formatDateTime(event.at) : "-"}</time>
          </article>
        ))}
      </div>
      <div className="events-list">
        {groupedEvents.length ? groupedEvents.map((group) => (
          <section className="event-day-group" key={group.label}>
            <h3>{group.label}</h3>
            {group.events.map((event) => (
              <article className={`event-row event-row--${event.severity}`} key={event.id}>
                <span>{event.source}</span>
                <div>
                  <b>{event.title}</b>
                  <small>{event.detail}</small>
                </div>
                <time>{eventTime(event.ts)}</time>
              </article>
            ))}
          </section>
        )) : (
          <p className="action-message">当前筛选下没有事件。</p>
        )}
      </div>
    </DialogShell>
  );
}

function DockerOperationHistory({ events }: { events: RuntimeEvent[] }) {
  return (
    <div className="docker-history" aria-label="Docker 操作历史">
      <div className="docker-history__head">
        <b>操作历史</b>
        <span>{events.length ? "最近 5 条" : "暂无操作"}</span>
      </div>
      <div className="docker-history__list">
        {events.length ? events.map((event) => (
          <span className={`docker-history__item docker-history__item--${event.severity}`} key={event.id}>
            <i />
            <b>{event.title.replace(/^Docker\s*/, "")}</b>
            <em>{event.detail}</em>
            <time>{eventTime(event.ts)}</time>
          </span>
        )) : (
          <span className="docker-history__empty">启动、停止、重启等操作会记录在这里。</span>
        )}
      </div>
    </div>
  );
}

function PveManagerPanel({
  available,
  node,
  vms,
  message,
  busyAction,
  onAction
}: {
  available: boolean;
  node: string;
  vms: PveVm[];
  message: string;
  busyAction: string;
  onAction: (action: PveAction, label: string, vm: PveVm) => void;
}) {
  const [detailVm, setDetailVm] = useState<PveVm | null>(null);
  const [query, setQuery] = useState("");
  const [pinnedVms, setPinnedVms] = useState<string[]>(() => {
    try {
      return JSON.parse(window.localStorage.getItem("hometab.pinnedPve.v1") || "[]") as string[];
    } catch {
      return [];
    }
  });
  const visibleVms = vms
    .filter((vm) => {
      const text = `${vm.name || ""} ${vm.vmid} ${vm.type} ${vm.status}`.toLowerCase();
      return !query.trim() || text.includes(query.trim().toLowerCase());
    })
    .sort((a, b) => Number(pinnedVms.includes(`${b.type}:${b.vmid}`)) - Number(pinnedVms.includes(`${a.type}:${a.vmid}`)))
    .slice(0, 8);

  function togglePin(vm: PveVm) {
    const key = `${vm.type}:${vm.vmid}`;
    setPinnedVms((current) => {
      const next = current.includes(key) ? current.filter((item) => item !== key) : [key, ...current].slice(0, 12);
      window.localStorage.setItem("hometab.pinnedPve.v1", JSON.stringify(next));
      return next;
    });
  }

  return (
    <section className="pve-manager" aria-label="PVE 实例管理">
      <div className="pve-manager__head">
        <div>
          <span className="eyebrow">PVE Manager</span>
          <b>VM / LXC</b>
        </div>
        <span className={available ? "pve-node pve-node--online" : "pve-node"}>
          <i />
          {available ? `${node || "node"} 在线` : "未连接"}
        </span>
      </div>
      <div className="ops-filterbar">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 VM / LXC / VMID / 状态" />
      </div>
      <div className="pve-vm-list">
        {visibleVms.length ? visibleVms.map((vm) => {
          const isRunning = vm.status === "running";
          const cpu = Math.round(Number(vm.cpu || 0) * 100);
          const memory = vm.maxmem ? Math.round((Number(vm.mem || 0) / Number(vm.maxmem)) * 100) : 0;
          const busy = busyAction.includes(`:${vm.vmid}`);
          return (
            <article className="pve-vm-row" key={`${vm.type}-${vm.vmid}`} onClick={() => setDetailVm(vm)}>
              <span className={`run-state run-state--${isRunning ? "running" : "stopped"}`} />
              <div className="pve-vm-row__name">
                <b>{vm.name || vm.vmid}</b>
                <small>{vm.type.toUpperCase()} {vm.vmid} · {vm.status}{pinnedVms.includes(`${vm.type}:${vm.vmid}`) ? " · 置顶" : ""}</small>
              </div>
              <ResourceMeter value={cpu} label={`${cpu}%`} />
              <ResourceMeter value={memory} label={`${memory}%`} />
              <div className="pve-vm-actions">
                <button type="button" onClick={(event) => { event.stopPropagation(); setDetailVm(vm); }}>详情</button>
                <button type="button" disabled={busy || isRunning} onClick={(event) => { event.stopPropagation(); onAction("start", "启动", vm); }}>启动</button>
                <button type="button" disabled={busy || !isRunning} onClick={(event) => { event.stopPropagation(); onAction("shutdown", "关机", vm); }}>关机</button>
                <button type="button" disabled={busy || !isRunning} onClick={(event) => { event.stopPropagation(); onAction("reboot", "重启", vm); }}>重启</button>
                <button type="button" disabled={busy || !isRunning} onClick={(event) => { event.stopPropagation(); onAction("stop", "强停", vm); }}>强停</button>
                <button type="button" onClick={(event) => { event.stopPropagation(); togglePin(vm); }}>置顶</button>
              </div>
            </article>
          );
        }) : (
          <p className="action-message">暂无可显示的 PVE VM/LXC。</p>
        )}
      </div>
      {message ? <p className="action-message">{message}</p> : null}
      {detailVm ? <PveDetailDialog vm={detailVm} node={node} onClose={() => setDetailVm(null)} /> : null}
    </section>
  );
}

function PveDetailDialog({ vm, node, onClose }: { vm: PveVm; node: string; onClose: () => void }) {
  const cpu = Math.round(Number(vm.cpu || 0) * 100);
  const memory = vm.maxmem ? Math.round((Number(vm.mem || 0) / Number(vm.maxmem)) * 100) : 0;

  return (
    <DialogShell className="utility-dialog utility-dialog--wide" onClose={onClose}>
      <DialogHead title={`${vm.name || vm.vmid} 详情`} subtitle={`${node || vm.node || "node"} · ${vm.type.toUpperCase()} ${vm.vmid}`} onClose={onClose} />
      <div className="container-config-grid">
        <InfoBlock title="状态">
          <span>运行状态：{vm.status}</span>
          <span>类型：{vm.type.toUpperCase()}</span>
          <span>VMID：{vm.vmid}</span>
        </InfoBlock>
        <InfoBlock title="资源">
          <span>CPU：{cpu}%</span>
          <span>内存：{memory}%</span>
          <span>内存用量：{formatBytes(Number(vm.mem))} / {formatBytes(Number(vm.maxmem))}</span>
        </InfoBlock>
      </div>
    </DialogShell>
  );
}

function ContainerLogsPanel({ container, onClose }: { container: DockerService; onClose: () => void }) {
  const [logs, setLogs] = useState("");
  const [filter, setFilter] = useState("");
  const [live, setLive] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [tail, setTail] = useState(300);
  const [message, setMessage] = useState("");

  const loadLogs = useCallback(async () => {
    if (!container.id) return;
    try {
      const response = await fetch(`/api/docker/containers/${encodeURIComponent(container.id)}/logs?tail=${tail}`);
      const text = await response.text();
      setLogs(response.ok ? text : `读取失败：${text}`);
      setMessage(response.ok ? `已同步 ${formatRefreshTime(new Date().toISOString())}` : "日志读取失败");
    } catch {
      setMessage("当前页面没有连接到后端 API，无法读取真实日志。");
    }
  }, [container.id, tail]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      void loadLogs();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [live, loadLogs]);

  const lines = logs.split("\n").map(cleanLogLine).filter((line, index, array) => line || index < array.length - 1);
  const filteredLines = filter.trim()
    ? lines.filter((line) => line.toLowerCase().includes(filter.trim().toLowerCase()))
    : lines;
  const visibleText = filteredLines.join("\n");

  function downloadCurrentLogs() {
    const date = new Date().toISOString().replace(/[:.]/g, "-");
    downloadText(`${safeFilename(container.name)}-logs-${date}.log`, visibleText);
  }

  return (
    <DialogShell className="utility-dialog utility-dialog--wide logs-dialog" onClose={onClose}>
      <DialogHead title={`${container.name} 日志`} subtitle={message || "实时跟随飞牛 OS Docker logs"} onClose={onClose} />
      <div className="logs-meta">
        <span>{filteredLines.length} / {lines.length} 行</span>
        <span>{live ? "实时跟随中" : "已暂停"}</span>
        <span>{wrap ? "自动换行" : "保持原始列宽"}</span>
      </div>
      <div className="logs-toolbar">
        <label className="plain-label">
          关键词过滤
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="error / warn / 关键字" />
        </label>
        <label className="plain-label logs-tail">
          行数
          <select value={tail} onChange={(event) => setTail(Number(event.target.value))}>
            <option value={120}>120</option>
            <option value={300}>300</option>
            <option value={500}>500</option>
          </select>
        </label>
        <div className="logs-filter-actions" aria-label="日志快捷筛选">
          <button type="button" onClick={() => setFilter("")}>全部</button>
          <button type="button" onClick={() => setFilter("error")}>错误</button>
          <button type="button" onClick={() => setFilter("warn")}>警告</button>
        </div>
        <button type="button" onClick={() => setLive((current) => !current)}>
          <UiIcon name={live ? "stop" : "refresh"} />
          {live ? "暂停跟随" : "继续跟随"}
        </button>
        <button type="button" onClick={() => setWrap((current) => !current)}>
          <UiIcon name="menu" />
          {wrap ? "不换行" : "换行"}
        </button>
        <button type="button" onClick={loadLogs}>
          <UiIcon name="refresh" />
          立即刷新
        </button>
        <button type="button" onClick={downloadCurrentLogs}>
          <UiIcon name="download" />
          下载
        </button>
      </div>
      <div className={wrap ? "logs-stream logs-stream--wrap" : "logs-stream"} role="log" aria-label={`${container.name} 日志内容`}>
        {filteredLines.map((line, index) => (
          <div className={`log-line log-line--${logLineLevel(line)}`} key={`${index}-${line.slice(0, 32)}`}>
            <span className="log-line__no">{index + 1}</span>
            <code>{line || " "}</code>
          </div>
        ))}
      </div>
    </DialogShell>
  );
}

function DiagnosticsPanel({
  diagnostics,
  lastRefreshAt,
  onRefresh
}: {
  diagnostics: DiagnosticCheck[];
  lastRefreshAt: string;
  onRefresh: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const checks = diagnostics.length
    ? diagnostics
    : [
        { id: "pending", label: "连接诊断", status: "warn" as const, detail: "等待第一次运行时采样" }
      ];

  async function refreshNow() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="diagnostics-strip" aria-label="连接诊断">
      <div className="diagnostics-strip__head">
        <span className="eyebrow">Diagnostics</span>
        <b>连接诊断</b>
        <small>最近刷新 {formatRefreshTime(lastRefreshAt)}</small>
      </div>
      <div className="diagnostics-strip__checks">
        {checks.map((item) => (
          <span className={`diagnostic-pill diagnostic-pill--${item.status}`} key={item.id} title={item.detail}>
            <i />
            <strong>{item.label}</strong>
            <em>{item.detail}</em>
          </span>
        ))}
      </div>
      <button className="diagnostics-refresh" type="button" disabled={refreshing} onClick={refreshNow}>
        <UiIcon name="refresh" />
        {refreshing ? "刷新中" : "刷新"}
      </button>
    </section>
  );
}

function DeviceCard({
  name,
  subtitle,
  status,
  accent,
  logo,
  metrics,
  footer,
  onOpen
}: {
  name: string;
  subtitle: string;
  status: string;
  accent: "teal" | "orange";
  logo: ReactNode;
  metrics: Array<{ label: string; value: number; points: MetricPoint[] }>;
  footer: string[];
  onOpen: () => void;
}) {
  return (
    <article className={`device-card device-card--${accent}`}>
      <button className="device-card__open" type="button" aria-label={`打开 ${name}`} onClick={onOpen}>
        <UiIcon name="open" />
      </button>
      <div className="device-card__title">
        <span className="device-logo">{logo}</span>
        <div>
          <h2>{name}</h2>
          <small>{subtitle}</small>
        </div>
        <em><i />{status}</em>
      </div>
      <div className="device-card__metrics">
        {metrics.map((metric) => (
          <MetricTrend key={metric.label} label={metric.label} value={metric.value} points={metric.points} />
        ))}
      </div>
      <div className="device-card__footer">
        {footer.map((item) => <span key={item}>{item}</span>)}
      </div>
    </article>
  );
}

function MetricTrend({ label, value, points }: { label: string; value: number; points: MetricPoint[] }) {
  return (
    <div className="metric-trend">
      <span>{label}</span>
      <b>{value}%</b>
      <Sparkline values={metricValues(points, value)} />
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const width = 220;
  const height = 44;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - (value / 100) * (height - 8) - 4;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = `0,${height} ${points} ${width},${height}`;

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={area} />
      <polyline points={points} />
    </svg>
  );
}

function ResourceMeter({ value, label, className = "" }: { value: number; label: string; className?: string }) {
  return (
    <span className={className ? `resource-meter ${className}` : "resource-meter"}>
      <b>{label}</b>
      <i><em style={{ width: `${value}%` }} /></i>
    </span>
  );
}

function ContainerDetailPanel({
  container,
  actionMessage,
  history,
  isBusy,
  onLogs,
  onConfig,
  onToggle,
  onRestart,
  onUpdateCheck,
  onPullImage,
  onRecreate,
  onRollbackList,
  updateMessage,
  updateReport,
  undoState,
  onUndo
}: {
  container: DockerService;
  actionMessage: string;
  history?: Record<"cpu" | "memory" | "network", MetricPoint[]>;
  isBusy: boolean;
  onLogs: () => void;
  onConfig: () => void;
  onToggle: () => void;
  onRestart: () => void;
  onUpdateCheck: () => void;
  onPullImage: () => void;
  onRecreate: () => void;
  onRollbackList: () => void;
  updateMessage: string;
  updateReport?: DockerUpdateReport;
  undoState: { token: string; label: string; expiresAt: string } | null;
  onUndo: () => void;
}) {
  const cpu = readPercent(container.cpu);
  const memory = readPercent(container.memory);
  const networkScore = readNetworkScore(container.network);

  return (
    <div className="container-focus">
      <div className="container-focus__identity">
        <span className="container-mark">{container.name?.slice(0, 2) || "ct"}</span>
        <div>
          <h3>{container.name}</h3>
          <small>{container.image || "unknown image"}</small>
          <em><i />{container.status || container.state}</em>
          {container.health ? <small>{healthText(container.health)}</small> : null}
        </div>
      </div>
      <div className="container-meta-grid" aria-label={`${container.name} 容器详情`}>
        <span><b>镜像</b><em>{container.image || "-"}</em></span>
        <span><b>端口</b><em>{container.portsText || container.accessUrls?.[0]?.hostPort || "-"}</em></span>
        <span><b>网络</b><em>{container.network || "-"}</em></span>
        <span><b>块 I/O</b><em>{container.block || "-"}</em></span>
        <span><b>PID</b><em>{container.pids || "-"}</em></span>
        <span><b>重启策略</b><em>{container.restartPolicy || "-"}</em></span>
      </div>
      <div className="focus-charts">
        <ChartCard label="CPU 使用率" value={`${container.cpu || "0%"}`} values={metricValues(history?.cpu || [], cpu)} />
        <ChartCard label="内存使用" value={container.memoryUsage || container.memory || "0%"} values={metricValues(history?.memory || [], memory)} />
        <ChartCard label="网络 I/O" value={container.network || "-"} values={metricValues(history?.network || [], networkScore)} />
      </div>
      <div className="focus-actions">
        <div className="container-links">
          {container.accessUrls?.length ? (
            container.accessUrls.slice(0, 3).map((item) => (
              <button key={item.url} type="button" onClick={() => openUrl(item.url)}>
                {item.url}
                <small className={`web-status web-status--${item.webStatus || "unknown"}`}>
                  {webStatusText(item.webStatus, item.httpStatus)}
                  {item.latencyMs ? ` · ${item.latencyMs}ms` : ""}
                </small>
              </button>
            ))
          ) : (
            <span>没有暴露访问地址</span>
          )}
        </div>
        <div className="panel-actions panel-actions--containers">
          <button type="button" disabled={isBusy} onClick={onLogs}><UiIcon name="logs" />日志</button>
          <button type="button" disabled={isBusy} onClick={onConfig}><UiIcon name="settings" />配置</button>
          <button type="button" disabled={isBusy} onClick={onRestart}><UiIcon name="refresh" />重启</button>
          <button type="button" disabled={isBusy} onClick={onToggle}><UiIcon name={container.state === "running" ? "stop" : "open"} />{container.state === "running" ? "停止" : "启动"}</button>
        </div>
      </div>
      <div className="update-center">
        <b>更新中心</b>
        {updateReport ? (
          <div className="update-digest-grid">
            <span><b>本地 digest</b><em>{updateReport.localDigest || "-"}</em></span>
            <span><b>远端 digest</b><em>{updateReport.remoteDigest || "-"}</em></span>
            <span><b>更新状态</b><em>{updateReport.hasUpdate ? "发现新镜像" : "暂无更新"}</em></span>
            <span><b>重建安全</b><em>{updateReport.safety?.safe ? "可安全复原" : `风险：${updateReport.safety?.risks?.join(", ") || "-"}`}</em></span>
          </div>
        ) : null}
        <div className="panel-actions panel-actions--containers">
          <button type="button" disabled={isBusy} onClick={onUpdateCheck}><UiIcon name="search" />检查</button>
          <button type="button" disabled={isBusy} onClick={onPullImage}><UiIcon name="download" />拉取</button>
          <button type="button" disabled={isBusy} onClick={onRecreate}><UiIcon name="refresh" />重建</button>
          <button type="button" disabled={isBusy} onClick={onRollbackList}><UiIcon name="cloud" />备份</button>
        </div>
        {updateMessage ? <small>{updateMessage}</small> : <small>拉取、重建前会自动保存容器配置备份。</small>}
      </div>
      {undoState ? (
        <div className="undo-window">
          <span>{undoState.label}窗口至 {formatDateTime(undoState.expiresAt)}</span>
          <button type="button" disabled={isBusy} onClick={onUndo}>撤销</button>
        </div>
      ) : null}
      {actionMessage ? <p className="action-message">{actionMessage}</p> : null}
    </div>
  );
}

function ChartCard({ label, value, values }: { label: string; value: string; values: number[] }) {
  return (
    <article className="chart-card">
      <div>
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <Sparkline values={values} />
    </article>
  );
}

function ContainerConfigDialog({ detail, onClose }: { detail: Record<string, unknown>; onClose: () => void }) {
  const env = Array.isArray(detail.env) ? detail.env : [];
  const mounts = Array.isArray(detail.mounts) ? detail.mounts : [];
  const links = Array.isArray(detail.accessUrls) ? detail.accessUrls : [];
  const ports = detail.ports && typeof detail.ports === "object" ? Object.entries(detail.ports as Record<string, unknown>) : [];
  const labels = detail.labels && typeof detail.labels === "object" ? Object.entries(detail.labels as Record<string, string>) : [];
  const state = detail.state && typeof detail.state === "object" ? detail.state as Record<string, unknown> : {};
  const [envFilter, setEnvFilter] = useState("");
  const filteredEnv = env.filter((item) => String(item).toLowerCase().includes(envFilter.trim().toLowerCase()));

  return (
    <DialogShell className="utility-dialog utility-dialog--wide" onClose={onClose}>
        <DialogHead title={String(detail.name || "容器配置")} subtitle={String(detail.image || "")} onClose={onClose} />
        <div className="container-config-grid">
          <InfoBlock title="访问地址">
            {links.length ? (
              links.map((item) => {
                const link = item as { url?: string; label?: string; hostPort?: string; webStatus?: string; httpStatus?: number; latencyMs?: number };
                return (
                  <button key={link.url} type="button" onClick={() => openUrl(link.url)}>
                    {link.url}
                    <small className={`web-status web-status--${link.webStatus || "unknown"}`}>
                      {webStatusText(link.webStatus, link.httpStatus)}
                      {link.latencyMs ? ` · ${link.latencyMs}ms` : ""}
                    </small>
                  </button>
                );
              })
            ) : (
              <span>没有暴露端口</span>
            )}
          </InfoBlock>
          <InfoBlock title="运行配置">
            <span>创建时间：{String(detail.created || "-")}</span>
            <span>启动时间：{String(state.StartedAt || "-")}</span>
            <span>镜像：{String(detail.image || "-")}</span>
            <span>重启策略：{String(detail.restartPolicy || "未设置")}</span>
            <span>工作目录：{String(detail.workingDir || "-")}</span>
            <span>命令：{String(detail.command || "-")}</span>
          </InfoBlock>
          <InfoBlock title="端口映射">
            {ports.length ? ports.map(([port, value]) => (
              <span key={port}>{port}：{Array.isArray(value) ? value.map((item) => {
                const row = item as { HostIp?: string; HostPort?: string };
                return `${row.HostIp || "0.0.0.0"}:${row.HostPort || "-"}`;
              }).join(" / ") : "未映射"}</span>
            )) : <span>没有端口映射</span>}
          </InfoBlock>
          <InfoBlock title="挂载">
            {mounts.length ? mounts.slice(0, 8).map((mount, index) => {
              const item = mount as { source?: string; destination?: string; mode?: string; rw?: boolean };
              return <span key={`${item.destination}-${index}`}>{item.source} → {item.destination} {item.rw === false ? "只读" : ""}</span>;
            }) : <span>没有挂载</span>}
          </InfoBlock>
          <InfoBlock title="环境变量">
            <input className="config-filter" value={envFilter} onChange={(event) => setEnvFilter(event.target.value)} placeholder="搜索环境变量" />
            {filteredEnv.length ? filteredEnv.slice(0, 18).map((item) => <span key={String(item)}>{String(item)}</span>) : <span>没有匹配的环境变量</span>}
          </InfoBlock>
          <InfoBlock title="标签">
            {labels.length ? labels.slice(0, 12).map(([key, value]) => <span key={key}>{key}：{String(value)}</span>) : <span>没有标签</span>}
          </InfoBlock>
        </div>
    </DialogShell>
  );
}

function InfoBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="info-block">
      <h3>{title}</h3>
      <div>{children}</div>
    </article>
  );
}

function AddBookmarkDialog({
  open,
  categories,
  defaultCategory,
  initialBookmark,
  onClose,
  onAdd
}: {
  open: boolean;
  categories: string[];
  defaultCategory: string;
  initialBookmark?: Bookmark | null;
  onClose: () => void;
  onAdd: (bookmark: Bookmark) => void;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState(defaultCategory || "常用");
  const [resolvedLogo, setResolvedLogo] = useState("");
  const normalized = normalizeUrl(url);
  const hostname = getHostname(url);
  const previewName = name.trim() || hostname || "新网站";
  const previewBookmark: Bookmark = {
    name: previewName,
    url: normalized || "https://example.com",
    category,
    icon: previewName.slice(0, 1).toUpperCase(),
    color: "light",
    logoUrl: resolvedLogo || undefined
  };

  useEffect(() => {
    if (!open) {
      setUrl("");
      setName("");
      setCategory(defaultCategory || "常用");
      setResolvedLogo("");
      return;
    }
    if (initialBookmark) {
      setUrl(initialBookmark.url);
      setName(initialBookmark.name);
      setCategory(initialBookmark.category || defaultCategory || "常用");
      setResolvedLogo(initialBookmark.logoUrl || "");
    }
  }, [defaultCategory, initialBookmark, open]);

  useEffect(() => {
    setResolvedLogo("");
  }, [url]);

  if (!open) return null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hostname) return;

    onAdd({
      name: previewName,
      url: normalized,
      category,
      icon: previewName.slice(0, 1).toUpperCase(),
      color: "light",
      logoUrl: resolvedLogo || getLogoCandidates({ url: normalized })[0]
    });
    onClose();
  }

  return (
    <DialogShell className="add-dialog" onClose={onClose}>
      <form className="dialog-form" onSubmit={handleSubmit}>
        <div className="add-dialog__head">
          <div>
            <h2>{initialBookmark ? "编辑网址" : "添加网址"}</h2>
            <p>粘贴网站地址后会自动尝试提取网站 Logo，也可以手动修改名称和分类。</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <label>
          网站地址
          <input
            autoFocus
            placeholder="https://example.com"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              if (!name && pasted) {
                const nextHost = getHostname(pasted);
                if (nextHost) setName(nextHost.split(".")[0]);
              }
            }}
          />
        </label>

        <label>
          显示名称
          <input placeholder={hostname || "网站名称"} value={name} onChange={(event) => setName(event.target.value)} />
        </label>

        <label>
          分类
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>

        <div className="logo-preview">
          {hostname ? <BookmarkLogo bookmark={previewBookmark} onResolved={setResolvedLogo} /> : <span className="logo-fallback logo-fallback--large">+</span>}
          <div>
            <b>{previewName}</b>
            <span>{hostname || "等待粘贴网址"}</span>
          </div>
        </div>

        <div className="add-dialog__actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" disabled={!hostname}>
            {initialBookmark ? "保存修改" : "添加到首页"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function Notice({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    if (!message) return undefined;
    const timer = window.setTimeout(onClose, 2600);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);

  if (!message) return null;
  return (
    <div className="notice" role="status">
      {message}
    </div>
  );
}

function DialogShell({
  children,
  className = "utility-dialog",
  onClose
}: {
  children: ReactNode;
  className?: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((item) => item.offsetParent !== null);
    const currentFocus = document.activeElement;
    if (!(currentFocus instanceof HTMLElement) || !dialog.contains(currentFocus)) {
      const autofocus = dialog.querySelector<HTMLElement>("[autofocus]");
      (autofocus || focusables()[0] || dialog).focus();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [onClose]);

  const dialog = (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className={className}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </section>
    </div>
  );

  return createPortal(dialog, document.body);
}

function WallpaperDialog({
  open,
  wallpaper,
  onChange,
  onClose
}: {
  open: boolean;
  wallpaper: ThemeId;
  onChange: (wallpaper: ThemeId) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  const options = [
    { id: "liquid", name: "macOS 流体玻璃", desc: "半透明毛玻璃、柔和高光、轻量桌面感" },
    { id: "cyber", name: "赛博朋克", desc: "霓虹线框、暗场面板、高对比运维态" },
    { id: "hacker", name: "黑客代码", desc: "终端矩阵、扫描线、代码仪表语言" },
    { id: "pixel", name: "16 比特动画", desc: "像素边框、块状按钮、复古游戏面板" },
    { id: "hud", name: "Future White HUD", desc: "白色航电 HUD、蓝灰网格、精密仪表" }
  ] satisfies Array<{ id: ThemeId; name: string; desc: string }>;

  return (
    <DialogShell onClose={onClose}>
        <DialogHead title="主题" subtitle="五套主题会改变材质、边框、配色和工作台氛围。" onClose={onClose} />
        <div className="wallpaper-options">
          {options.map((option) => (
            <button
              className={wallpaper === option.id ? "wallpaper-option wallpaper-option--active" : "wallpaper-option"}
              key={option.id}
              type="button"
              onClick={() => onChange(option.id)}
            >
              <span className={`wallpaper-swatch wallpaper-swatch--${option.id}`} />
              <b>{option.name}</b>
              <small>{option.desc}</small>
            </button>
          ))}
        </div>
    </DialogShell>
  );
}

function SettingsDialog({
  open,
  config,
  connections,
  alertRules,
  customCount,
  allBookmarks,
  authToken,
  authStatus,
  onSave,
  onOrganizeBookmarks,
  onSaveConnections,
  onSaveAlertRules,
  onRefreshRuntime,
  onRequireAuth,
  onAuthExpired,
  onResetBookmarks,
  onClose
}: {
  open: boolean;
  config: AppConfig;
  connections: ConnectionSettings;
  alertRules: AlertRules;
  customCount: number;
  allBookmarks: Bookmark[];
  authToken: string;
  authStatus: AuthStatus;
  onSave: (config: AppConfig) => Promise<void>;
  onOrganizeBookmarks: (bookmarks: Bookmark[], categories: string[]) => Promise<void>;
  onSaveConnections: (connections: ConnectionSettings) => Promise<void>;
  onSaveAlertRules: (rules: AlertRules) => void;
  onRefreshRuntime: () => Promise<void>;
  onRequireAuth: () => boolean;
  onAuthExpired: () => void;
  onResetBookmarks: () => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [connectionDraft, setConnectionDraft] = useState<ConnectionSettings>(connections);
  const [alertDraft, setAlertDraft] = useState<AlertRules>(alertRules);
  const [notificationDraft, setNotificationDraft] = useState<NotificationSettingsDraft>({
    enabled: false,
    barkConfigured: false,
    serverChanConfigured: false,
    telegramConfigured: false,
    webhookConfigured: false,
    wecomConfigured: false,
    quietMinutes: 15,
    dailySummaryEnabled: false,
    dailySummaryHour: 9,
    lastDailySummaryDate: "",
    barkUrl: "",
    serverChanKey: "",
    telegramBotToken: "",
    telegramChatId: "",
    webhookUrl: "",
    wecomWebhookUrl: ""
  });
  const [categoryDraft, setCategoryDraft] = useState<string[]>(config.categories);
  const [newCategory, setNewCategory] = useState("");
  const [message, setMessage] = useState("");
  const [notificationTestResult, setNotificationTestResult] = useState("");

  useEffect(() => {
    if (open) {
      setDraft(JSON.stringify(config, null, 2));
      setConnectionDraft({
        fnos: { ...connections.fnos, sshPassword: "" },
        pve: { ...connections.pve, password: "", tokenSecret: "" }
      });
      setAlertDraft(alertRules);
      setCategoryDraft(config.categories);
      setNewCategory("");
      setMessage("");
      setNotificationTestResult("");
    }
  }, [alertRules, config, connections, open]);

  useEffect(() => {
    if (!open) return;
    if (authStatus.required && !authStatus.authenticated) return;
    let active = true;
    fetch("/api/notifications", { headers: authHeaders(authToken) })
      .then((response) => {
        if (response.status === 401) {
          onAuthExpired();
          throw new Error("请先解锁后再配置通知。");
        }
        if (!response.ok) throw new Error("通知配置读取失败。");
        return response.json() as Promise<NotificationPublicSettings>;
      })
      .then((settings) => {
        if (!active) return;
        setNotificationDraft((current) => ({
          ...current,
          ...settings,
          barkUrl: "",
          serverChanKey: "",
          telegramBotToken: "",
          telegramChatId: "",
          webhookUrl: "",
          wecomWebhookUrl: ""
        }));
      })
      .catch((error) => {
        if (active) setMessage(error instanceof Error ? error.message : "通知配置读取失败。");
      });
    return () => {
      active = false;
    };
  }, [authStatus.authenticated, authStatus.required, authToken, onAuthExpired, open]);

  if (!open) return null;

  async function save() {
    try {
      const next = JSON.parse(draft) as AppConfig;
      if (!Array.isArray(next.categories) || !Array.isArray(next.bookmarks)) throw new Error("缺少 categories 或 bookmarks");
      await onSave(next);
      setMessage("配置已保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "配置格式不正确。");
    }
  }

  async function saveCategories(nextCategories = categoryDraft, nextBookmarks = allBookmarks) {
    const normalized = [...new Set(nextCategories.map((item) => item.trim()).filter(Boolean))];
    if (!normalized.length) {
      setMessage("至少保留一个分类。");
      return;
    }
    if (!config.bookmarks.length) {
      setMessage("默认书签数据异常，已停止保存。请先恢复备份或刷新运行时。");
      return;
    }
    try {
      await onOrganizeBookmarks(nextBookmarks, normalized);
      const defaultUrlSet = new Set(config.bookmarks.map((bookmark) => bookmarkKey(bookmark.url)));
      const nextConfigBookmarks = nextBookmarks.filter((bookmark) => defaultUrlSet.has(bookmarkKey(bookmark.url)));
      setCategoryDraft(normalized);
      setDraft(JSON.stringify({ ...config, categories: normalized, bookmarks: nextConfigBookmarks }, null, 2));
      setMessage("分类已保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "分类保存失败。");
    }
  }

  async function addCategory() {
    const name = newCategory.trim();
    if (!name) return;
    if (categoryDraft.includes(name)) {
      setMessage("分类已存在。");
      return;
    }
    setNewCategory("");
    await saveCategories([...categoryDraft, name]);
  }

  async function renameCategory(oldName: string, nextName: string) {
    const name = nextName.trim();
    if (!name || name === oldName) return;
    if (categoryDraft.includes(name)) {
      setMessage("分类已存在。");
      return;
    }
    const nextCategories = categoryDraft.map((item) => (item === oldName ? name : item));
    const nextBookmarks = allBookmarks.map((bookmark) => bookmark.category === oldName ? { ...bookmark, category: name } : bookmark);
    await saveCategories(nextCategories, nextBookmarks);
  }

  async function removeCategory(category: string) {
    if (categoryDraft.length <= 1) {
      setMessage("至少保留一个分类。");
      return;
    }
    const fallback = categoryDraft.find((item) => item !== category) || "常用";
    const nextCategories = categoryDraft.filter((item) => item !== category);
    const nextBookmarks = allBookmarks.map((bookmark) => bookmark.category === category ? { ...bookmark, category: fallback } : bookmark);
    await saveCategories(nextCategories, nextBookmarks);
  }

  async function saveConnections() {
    try {
      await onSaveConnections(connectionDraft);
      setMessage("连接配置已保存，刷新运行时后会读取最新状态。");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "连接配置保存失败。");
      return false;
    }
  }

  async function refreshStatus() {
    try {
      await onRefreshRuntime();
      setMessage("状态已刷新。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "状态刷新失败。");
    }
  }

  async function saveConnectionsAndRefresh() {
    const saved = await saveConnections();
    if (!saved) return;
    await refreshStatus();
  }

  function updateAlertPair(group: keyof AlertRules, metric: string, field: keyof AlertPair, value: string) {
    const numberValue = Number(value);
    setAlertDraft((current) => normalizeAlertRules({
      ...current,
      [group]: {
        ...current[group],
        [metric]: {
          ...(current[group] as Record<string, AlertPair>)[metric],
          [field]: Number.isFinite(numberValue) ? numberValue : 0
        }
      }
    } as Partial<AlertRules>));
  }

  async function saveAlertsAndRefresh() {
    onSaveAlertRules(alertDraft);
    setMessage("告警规则已保存，下一次采样会按新阈值判断。");
    await refreshStatus();
  }

  async function saveNotifications(testAfterSave = false) {
    if (!onRequireAuth()) return;
    try {
      const response = await fetch("/api/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders(authToken) },
        body: JSON.stringify(notificationDraft)
      });
      if (response.status === 401) {
        onAuthExpired();
        throw new Error("登录已过期，请重新解锁。");
      }
      if (!response.ok) throw new Error("通知配置保存失败。");
      const settings = (await response.json()) as NotificationPublicSettings;
      setNotificationDraft((current) => ({ ...current, ...settings, barkUrl: "", serverChanKey: "", telegramBotToken: "", telegramChatId: "", webhookUrl: "", wecomWebhookUrl: "" }));
      if (testAfterSave) {
        const testResponse = await fetch("/api/notifications/test", { method: "POST", headers: authHeaders(authToken) });
        if (testResponse.status === 401) {
          onAuthExpired();
          throw new Error("登录已过期，请重新解锁。");
        }
        if (!testResponse.ok) throw new Error("测试通知发送失败。");
        const result = await testResponse.json() as { ok?: boolean; results?: Array<{ channel: string; ok: boolean; status?: number; error?: string }>; skipped?: string };
        setNotificationTestResult(result.results?.map((item) => `${item.channel}: ${item.ok ? "成功" : `失败 ${item.status || item.error || ""}`}`).join(" / ") || `跳过：${result.skipped || "无通道"}`);
        setMessage(result.ok ? "通知配置已保存，测试通知已发送。" : "通知配置已保存，但没有可用通道或通道未返回成功。");
        return;
      }
      setMessage("通知配置已保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "通知配置保存失败。");
    }
  }

  return (
    <DialogShell className="utility-dialog utility-dialog--wide" onClose={onClose}>
        <DialogHead title="设置" subtitle={`当前有 ${customCount} 个自定义书签。`} onClose={onClose} />
        <div className="connection-grid">
          <label className="plain-label">
            飞牛 OS 地址
            <input
              value={connectionDraft.fnos.url}
              onChange={(event) => setConnectionDraft((current) => ({ ...current, fnos: { ...current.fnos, url: event.target.value } }))}
            />
          </label>
          <label className="plain-label">
            飞牛 SSH 主机
            <input
              value={connectionDraft.fnos.sshHost}
              onChange={(event) => setConnectionDraft((current) => ({ ...current, fnos: { ...current.fnos, sshHost: event.target.value } }))}
            />
          </label>
          <label className="plain-label">
            飞牛 SSH 用户
            <input
              value={connectionDraft.fnos.sshUsername}
              onChange={(event) => setConnectionDraft((current) => ({ ...current, fnos: { ...current.fnos, sshUsername: event.target.value } }))}
            />
          </label>
          <label className="plain-label">
            飞牛 SSH 密码
            <input
              type="password"
              placeholder={connections.fnos.sshPasswordConfigured ? "已配置，留空不修改" : "未配置"}
              value={connectionDraft.fnos.sshPassword || ""}
              onChange={(event) => setConnectionDraft((current) => ({ ...current, fnos: { ...current.fnos, sshPassword: event.target.value } }))}
            />
          </label>
          <label className="plain-label connection-grid__wide">
            PVE 地址
            <input
              value={connectionDraft.pve.url}
              onChange={(event) => setConnectionDraft((current) => ({ ...current, pve: { ...current.pve, url: event.target.value } }))}
            />
          </label>
          <label className="plain-label">
            PVE 用户
            <input
              value={connectionDraft.pve.username}
              onChange={(event) => setConnectionDraft((current) => ({ ...current, pve: { ...current.pve, username: event.target.value } }))}
            />
          </label>
          <label className="plain-label">
            PVE 密码
            <input
              type="password"
              placeholder={connections.pve.passwordConfigured ? "已配置，留空不修改" : "未配置"}
              value={connectionDraft.pve.password || ""}
              onChange={(event) => setConnectionDraft((current) => ({ ...current, pve: { ...current.pve, password: event.target.value } }))}
            />
          </label>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={saveConnectionsAndRefresh}>
            保存连接
          </button>
          <button type="button" onClick={refreshStatus}>
            刷新状态
          </button>
        </div>
        <section className="notification-panel" aria-label="通知告警">
          <div className="alert-rules-panel__head">
            <b>通知告警</b>
            <small>Bark、Telegram、企业微信、Server 酱或通用 Webhook；密钥留空不会覆盖现有配置。</small>
          </div>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={notificationDraft.enabled}
              onChange={(event) => setNotificationDraft((current) => ({ ...current, enabled: event.target.checked }))}
            />
            启用主动推送
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={notificationDraft.dailySummaryEnabled}
              onChange={(event) => setNotificationDraft((current) => ({ ...current, dailySummaryEnabled: event.target.checked }))}
            />
            启用每日摘要
          </label>
          <div className="alert-rule-row">
            <span>通知策略</span>
            <label>
              静默分钟
              <input
                type="number"
                min={0}
                max={1440}
                value={notificationDraft.quietMinutes}
                onChange={(event) => setNotificationDraft((current) => ({ ...current, quietMinutes: Number(event.target.value) }))}
              />
            </label>
            <label>
              摘要小时
              <input
                type="number"
                min={0}
                max={23}
                value={notificationDraft.dailySummaryHour}
                onChange={(event) => setNotificationDraft((current) => ({ ...current, dailySummaryHour: Number(event.target.value) }))}
              />
            </label>
          </div>
          <div className="notification-status-grid">
            {[
              ["Bark", notificationDraft.barkConfigured],
              ["Telegram", notificationDraft.telegramConfigured],
              ["企业微信", notificationDraft.wecomConfigured],
              ["Server 酱", notificationDraft.serverChanConfigured],
              ["Webhook", notificationDraft.webhookConfigured]
            ].map(([name, configured]) => (
              <span key={String(name)} className={configured ? "is-ready" : ""}>
                {name} · {configured ? "已配置" : "未配置"}
              </span>
            ))}
          </div>
          <div className="connection-grid">
            <label className="plain-label">
              Bark URL
              <input
                placeholder={notificationDraft.barkConfigured ? "已配置，留空不修改" : "https://api.day.app/xxxx"}
                value={notificationDraft.barkUrl}
                onChange={(event) => setNotificationDraft((current) => ({ ...current, barkUrl: event.target.value }))}
              />
            </label>
            <label className="plain-label">
              Server 酱 SendKey
              <input
                placeholder={notificationDraft.serverChanConfigured ? "已配置，留空不修改" : "SCTxxxxxxxx"}
                value={notificationDraft.serverChanKey}
                onChange={(event) => setNotificationDraft((current) => ({ ...current, serverChanKey: event.target.value }))}
              />
            </label>
            <label className="plain-label">
              Telegram Bot Token
              <input
                placeholder={notificationDraft.telegramConfigured ? "已配置，留空不修改" : "123456:xxxx"}
                value={notificationDraft.telegramBotToken}
                onChange={(event) => setNotificationDraft((current) => ({ ...current, telegramBotToken: event.target.value }))}
              />
            </label>
            <label className="plain-label">
              Telegram Chat ID
              <input
                placeholder={notificationDraft.telegramConfigured ? "已配置，留空不修改" : "-100xxxxxxxx"}
                value={notificationDraft.telegramChatId}
                onChange={(event) => setNotificationDraft((current) => ({ ...current, telegramChatId: event.target.value }))}
              />
            </label>
            <label className="plain-label connection-grid__wide">
              企业微信机器人 Webhook
              <input
                placeholder={notificationDraft.wecomConfigured ? "已配置，留空不修改" : "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."}
                value={notificationDraft.wecomWebhookUrl}
                onChange={(event) => setNotificationDraft((current) => ({ ...current, wecomWebhookUrl: event.target.value }))}
              />
            </label>
            <label className="plain-label connection-grid__wide">
              通用 Webhook
              <input
                placeholder={notificationDraft.webhookConfigured ? "已配置，留空不修改" : "https://example.com/hook"}
                value={notificationDraft.webhookUrl}
                onChange={(event) => setNotificationDraft((current) => ({ ...current, webhookUrl: event.target.value }))}
              />
            </label>
          </div>
          <div className="dialog-actions">
            <button type="button" onClick={() => void saveNotifications(false)}>
              保存通知
            </button>
            <button type="button" onClick={() => void saveNotifications(true)}>
              保存并测试
            </button>
          </div>
          {notificationTestResult ? <p className="dialog-message">{notificationTestResult}</p> : null}
        </section>
        <section className="category-manager" aria-label="分类管理">
          <div className="alert-rules-panel__head">
            <b>分类管理</b>
            <small>新增、重命名或删除分类；删除分类时，书签会自动移动到第一个保留分类。</small>
          </div>
          <div className="category-manager__add">
            <input
              placeholder="新分类名称"
              value={newCategory}
              onChange={(event) => setNewCategory(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void addCategory();
                }
              }}
            />
            <button type="button" onClick={addCategory}>
              新增分类
            </button>
          </div>
          <div className="category-list">
            {categoryDraft.map((category) => (
              <div className="category-row" key={category}>
                <input
                  defaultValue={category}
                  onBlur={(event) => renameCategory(category, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <span>{allBookmarks.filter((bookmark) => bookmark.category === category).length} 个书签</span>
                <button type="button" onClick={() => removeCategory(category)}>
                  删除
                </button>
              </div>
            ))}
          </div>
        </section>
        <section className="alert-rules-panel" aria-label="告警规则">
          <div className="alert-rules-panel__head">
            <b>告警规则</b>
            <small>Warn / Critical 阈值，保存后立即用于下一次 5 秒采样。</small>
          </div>
          <div className="alert-rule-grid">
            {([
              ["fnos", "FNOS", ["cpu", "memory", "storage"]],
              ["pve", "PVE", ["cpu", "memory", "storage"]],
              ["docker", "Docker", ["cpu", "memory"]]
            ] as const).map(([group, label, metrics]) => metrics.map((metric) => {
              const rule = alertDraft[group][metric];
              const metricLabel = metric === "cpu" ? "CPU" : metric === "memory" ? "内存" : "存储";
              return (
                <div className="alert-rule-row" key={`${group}-${metric}`}>
                  <span>{label} {metricLabel}</span>
                  <label>
                    Warn
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={rule.warn}
                      onChange={(event) => updateAlertPair(group, metric, "warn", event.target.value)}
                    />
                  </label>
                  <label>
                    Critical
                    <input
                      type="number"
                      min={2}
                      max={100}
                      value={rule.critical}
                      onChange={(event) => updateAlertPair(group, metric, "critical", event.target.value)}
                    />
                  </label>
                </div>
              );
            }))}
          </div>
          <div className="dialog-actions">
            <button type="button" onClick={() => setAlertDraft(defaultAlertRules)}>
              恢复默认
            </button>
            <button type="button" onClick={saveAlertsAndRefresh}>
              保存告警规则
            </button>
          </div>
        </section>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} />
        {message ? <p className="dialog-message">{message}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={onResetBookmarks}>
            清空自定义书签
          </button>
          <button type="button" onClick={save}>
            保存配置
          </button>
        </div>
    </DialogShell>
  );
}

function BackupDialog({
  open,
  onExport,
  onImport,
  onRestore,
  onClose
}: {
  open: boolean;
  onExport: () => Promise<string>;
  onImport: (file: File) => Promise<void>;
  onRestore: (backup: BackupPayload) => Promise<void>;
  onClose: () => void;
}) {
  const [message, setMessage] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<(BackupSummary & { payload?: BackupPayload; source: "file" | "server" }) | null>(null);
  const [recentBackups, setRecentBackups] = useState<BackupSummary[]>([]);
  const [backupSettings, setBackupSettings] = useState<BackupSettings>({ enabled: false, intervalHours: 24, keep: 14, note: "" });
  const [backupDiff, setBackupDiff] = useState<Record<string, unknown> | null>(null);
  const [loadingBackups, setLoadingBackups] = useState(false);

  const loadRecentBackups = useCallback(async () => {
    setLoadingBackups(true);
    try {
      const response = await fetch("/api/backups");
      if (!response.ok) throw new Error("backups request failed");
      const payload = (await response.json()) as { backups?: BackupSummary[] };
      setRecentBackups(Array.isArray(payload.backups) ? payload.backups : []);
    } catch {
      setRecentBackups([]);
    } finally {
      setLoadingBackups(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setMessage("");
      setPendingFile(null);
      setPreview(null);
      setBackupDiff(null);
      void loadRecentBackups();
      void fetch("/api/backups/settings").then((response) => response.ok ? response.json() : Promise.reject()).then(setBackupSettings).catch(() => undefined);
    }
  }, [loadRecentBackups, open]);

  if (!open) return null;

  async function previewBackup(file: File) {
    const payload = JSON.parse(await file.text()) as BackupPayload;
    if (!payload.config || !Array.isArray(payload.customBookmarks)) throw new Error("备份文件格式不正确");
    setPendingFile(file);
    setPreview({
      name: file.name,
      configBookmarks: payload.config.bookmarks?.length || 0,
      customBookmarks: payload.customBookmarks.length,
      categories: payload.config.categories?.length || 0,
      exportedAt: payload.exportedAt,
      payload,
      source: "file"
    });
    setMessage("已读取备份，请确认后再导入。");
  }

  async function previewRecentBackup(backup: BackupSummary) {
    const response = await fetch(`/api/backups/${encodeURIComponent(backup.name)}`);
    if (!response.ok) throw new Error("备份读取失败");
    const payload = (await response.json()) as BackupPayload;
    setPendingFile(null);
    setPreview({ ...backup, payload, source: "server" });
    setBackupDiff(null);
    setMessage("已读取历史备份，请确认后再恢复。");
  }

  async function saveBackupSettings() {
    const response = await fetch("/api/backups/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(backupSettings)
    });
    if (!response.ok) throw new Error("定时备份设置保存失败");
    setBackupSettings(await response.json());
    setMessage("定时备份设置已保存。");
  }

  async function compareBackup(backup: BackupSummary) {
    const response = await fetch(`/api/backups/${encodeURIComponent(backup.name)}/compare`);
    if (!response.ok) throw new Error("备份对比失败");
    const payload = await response.json();
    setBackupDiff(payload.diff || payload);
    setMessage("已生成当前配置与该备份的差异。");
  }

  async function downloadBackupArchive() {
    const response = await fetch("/api/backups/archive");
    if (!response.ok) throw new Error("备份压缩包下载失败");
    await downloadResponse(`hometab-backups-${new Date().toISOString().slice(0, 10)}.json.gz`, response);
    setMessage("全部备份压缩包已下载。");
  }

  return (
    <DialogShell onClose={onClose}>
        <DialogHead title="备份" subtitle="导出或恢复配置、默认数据和自定义书签。" onClose={onClose} />
        <div className="backup-actions">
          <button
            type="button"
            onClick={async () => {
              setMessage(await onExport());
              await loadRecentBackups();
            }}
          >
            <UiIcon name="cloudUpload" />
            导出备份
          </button>
          <label>
            <UiIcon name="download" />
            导入备份
            <input
              type="file"
              accept="application/json,.json"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                  await previewBackup(file);
                } catch (error) {
                  setMessage(error instanceof Error ? error.message : "导入失败。");
                }
              }}
            />
          </label>
          <button type="button" onClick={() => void downloadBackupArchive()}>
            <UiIcon name="download" />
            下载全部
          </button>
        </div>
        <div className="backup-preview">
          <b>自动定时备份</b>
          <label className="toggle-row">
            <input type="checkbox" checked={backupSettings.enabled} onChange={(event) => setBackupSettings((current) => ({ ...current, enabled: event.target.checked }))} />
            启用自动备份
          </label>
          <div className="alert-rule-row">
            <span>备份策略</span>
            <label>间隔小时<input type="number" min={1} max={168} value={backupSettings.intervalHours} onChange={(event) => setBackupSettings((current) => ({ ...current, intervalHours: Number(event.target.value) }))} /></label>
            <label>保留份数<input type="number" min={3} max={60} value={backupSettings.keep} onChange={(event) => setBackupSettings((current) => ({ ...current, keep: Number(event.target.value) }))} /></label>
          </div>
          <input className="text-input" placeholder="备份备注" value={backupSettings.note || ""} onChange={(event) => setBackupSettings((current) => ({ ...current, note: event.target.value }))} />
          <button type="button" onClick={() => void saveBackupSettings()}>保存定时策略</button>
          <small>上次自动备份：{backupSettings.lastRunAt ? formatDateTime(backupSettings.lastRunAt) : "尚未执行"}</small>
        </div>
        <div className="backup-preview">
          <b>最近备份</b>
          {loadingBackups ? <span>正在读取备份列表...</span> : null}
          {!loadingBackups && !recentBackups.length ? <span>还没有服务端备份，点击导出备份会自动保留一份。</span> : null}
          {recentBackups.map((backup) => (
            <button
              key={backup.name}
              type="button"
              className="backup-history-row"
              onClick={async () => {
                try {
                  await previewRecentBackup(backup);
                } catch (error) {
                  setMessage(error instanceof Error ? error.message : "历史备份读取失败。");
                }
              }}
            >
              <span>{backup.exportedAt ? formatDateTime(backup.exportedAt) : backup.name}</span>
              <small>{backup.configBookmarks + backup.customBookmarks} 个书签 · {backup.categories} 个分类</small>
              <small>{backup.version ? `v${backup.version}` : "v1"} · {backup.source || "manual"}{backup.note ? ` · ${backup.note}` : ""}</small>
            </button>
          ))}
        </div>
        {preview ? (
          <div className="backup-preview">
            <b>{preview.source === "server" ? "恢复预览" : "导入预览"}</b>
            <span>导出时间：{preview.exportedAt || "未知"}</span>
            <span>默认书签：{preview.configBookmarks} 个</span>
            <span>自定义书签：{preview.customBookmarks} 个</span>
            <span>分类：{preview.categories} 个</span>
            <span>版本：{preview.version || preview.payload?.version || "未知"}</span>
            <span>来源：{preview.source === "server" ? preview.payload?.source || "manual" : preview.payload?.source || "file"}</span>
            <button type="button" onClick={() => void compareBackup(preview)}>
              对比当前配置
            </button>
            <button type="button" onClick={async () => {
              if (preview.source === "file" && pendingFile) {
                await onImport(pendingFile);
              } else if (preview.payload) {
                await onRestore(preview.payload);
              }
              setMessage(preview.source === "server" ? "历史备份已恢复。" : "备份已导入。");
              setPendingFile(null);
              setPreview(null);
              await loadRecentBackups();
            }}>
              {preview.source === "server" ? "确认恢复" : "确认导入"}
            </button>
          </div>
        ) : null}
        {backupDiff ? (
          <div className="backup-preview">
            <b>备份差异</b>
            <span>当前书签数：{String((backupDiff as { currentCount?: number }).currentCount ?? "-")}</span>
            <span>备份书签数：{String((backupDiff as { backupCount?: number }).backupCount ?? "-")}</span>
            <span>备份新增：{String(((backupDiff as { addedBookmarks?: string[] }).addedBookmarks || []).length)}</span>
            <span>备份缺少：{String(((backupDiff as { removedBookmarks?: string[] }).removedBookmarks || []).length)}</span>
          </div>
        ) : null}
        {message ? <p className="dialog-message">{message}</p> : null}
    </DialogShell>
  );
}

function ImportBookmarksDialog({
  open,
  categories,
  defaultCategory,
  onImport,
  onClose
}: {
  open: boolean;
  categories: string[];
  defaultCategory: string;
  onImport: (bookmarks: Bookmark[]) => Promise<void>;
  onClose: () => void;
}) {
  const [category, setCategory] = useState(defaultCategory || "常用");
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (open) {
      setCategory(defaultCategory || "常用");
      setDraft("");
      setMessage("");
    }
  }, [defaultCategory, open]);

  if (!open) return null;

  async function submit() {
    const bookmarks = parseImportedBookmarks(draft, category);
    if (!bookmarks.length) {
      setMessage("没有识别到可导入的书签。");
      return;
    }
    await onImport(bookmarks);
    setMessage(`已导入 ${bookmarks.length} 个书签。`);
  }

  return (
    <DialogShell className="utility-dialog utility-dialog--wide" onClose={onClose}>
        <DialogHead title="导入书签" subtitle="支持 JSON 数组、备份里的 bookmarks，或每行一个“名称 URL”。" onClose={onClose} />
        <label className="plain-label">
          默认分类
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={'GitHub https://github.com\n少数派 https://sspai.com'}
          spellCheck={false}
        />
        {message ? <p className="dialog-message">{message}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            关闭
          </button>
          <button type="button" onClick={submit}>
            导入书签
          </button>
        </div>
    </DialogShell>
  );
}

function AuthDialog({ open, onLogin, onClose }: { open: boolean; onLogin: (password: string) => Promise<void>; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  if (!open) return null;
  async function submit() {
    try {
      await onLogin(password);
      setPassword("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录失败。");
    }
  }
  return (
    <DialogShell className="utility-dialog" onClose={onClose}>
      <DialogHead title="管理解锁" subtitle="Docker/PVE 危险操作需要管理密码。" onClose={onClose} />
      <label className="plain-label">管理密码</label>
      <input className="text-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => event.key === "Enter" ? void submit() : undefined} autoFocus />
      {message ? <p className="dialog-message">{message}</p> : null}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>取消</button>
        <button type="button" onClick={submit}>解锁</button>
      </div>
    </DialogShell>
  );
}

function SetupWizard({ open, onSetup, onClose }: { open: boolean; onSetup: (password: string) => Promise<void>; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  if (!open) return null;
  async function submit() {
    try {
      await onSetup(password);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "初始化失败。");
    }
  }
  return (
    <DialogShell className="utility-dialog" onClose={onClose}>
      <DialogHead title="首次配置向导" subtitle="设置管理密码后，再配置 FNOS、PVE、通知和主题。" onClose={onClose} />
      <div className="setup-steps">
        <span>1 设置管理密码</span>
        <span>2 设置 FNOS / PVE</span>
        <span>3 同步 Web 容器书签</span>
      </div>
      <label className="plain-label">管理密码</label>
      <input className="text-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
      {message ? <p className="dialog-message">{message}</p> : null}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>稍后</button>
        <button type="button" onClick={submit}>完成初始化</button>
      </div>
    </DialogShell>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busy,
  onConfirm,
  onCancel
}: {
  title: string;
  message: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <DialogShell className="utility-dialog confirm-dialog" onClose={busy ? () => undefined : onCancel}>
      <DialogHead title={title} subtitle={message} onClose={busy ? () => undefined : onCancel} />
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button type="button" disabled={busy} onClick={onConfirm}>
          {busy ? "处理中..." : confirmLabel}
        </button>
      </div>
    </DialogShell>
  );
}

function LoadingDialog({ title, message }: { title: string; message: string }) {
  return (
    <DialogShell className="utility-dialog confirm-dialog loading-dialog" onClose={() => undefined}>
      <DialogHead title={title} subtitle={message} onClose={() => undefined} />
      <div className="loading-dialog__body" role="status">
        <span className="loading-spinner" aria-hidden="true" />
        <span>请稍等，真实设备响应较慢时可能需要几秒。</span>
      </div>
    </DialogShell>
  );
}

function DialogHead({ title, subtitle, onClose }: { title: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="add-dialog__head">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      <button type="button" onClick={onClose} aria-label="关闭">
        ×
      </button>
    </div>
  );
}

function UiIcon({ name }: { name: string }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };

  switch (name) {
    case "home":
      return <svg {...common}><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" /></svg>;
    case "bookmark":
      return <svg {...common}><path d="M6 4h12v17l-6-4-6 4z" /></svg>;
    case "folder":
    case "folderSolid":
      return <svg {...common}><path d="M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
    case "folderColor":
      return <svg {...common}><path d="M3 8h7l2 2h9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#f6b64c" stroke="#d8962e" /></svg>;
    case "grid":
      return <svg {...common}><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" /></svg>;
    case "settings":
      return <svg {...common}><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1-2 3.4-.2-.1a1.7 1.7 0 0 0-1.9.2 8 8 0 0 1-1.6.9 1.7 1.7 0 0 0-1.1 1.5V23H9v-.2a1.7 1.7 0 0 0-1.1-1.5 8 8 0 0 1-1.6-.9 1.7 1.7 0 0 0-1.9-.2l-.2.1-2-3.4.1-.1A1.7 1.7 0 0 0 2.6 15a8 8 0 0 1 0-2 1.7 1.7 0 0 0-.3-1.8l-.1-.1 2-3.4.2.1a1.7 1.7 0 0 0 1.9-.2 8 8 0 0 1 1.6-.9A1.7 1.7 0 0 0 9 5.2V5h4v.2a1.7 1.7 0 0 0 1.1 1.5 8 8 0 0 1 1.6.9 1.7 1.7 0 0 0 1.9.2l.2-.1 2 3.4-.1.1a1.7 1.7 0 0 0-.3 1.8 8 8 0 0 1 0 2Z" /></svg>;
    case "moon":
      return <svg {...common}><path d="M21 14.2A8 8 0 0 1 9.8 3a7 7 0 1 0 11.2 11.2Z" /></svg>;
    case "search":
      return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>;
    case "network":
      return <svg {...common}><path d="M5 12.5a10 10 0 0 1 14 0" /><path d="M8.5 16a5 5 0 0 1 7 0" /><path d="M12 19h.01" /></svg>;
    case "menu":
      return <svg {...common}><path d="M5 7h14M5 12h14M5 17h14" /></svg>;
    case "chevron":
      return <svg {...common}><path d="m9 18 6-6-6-6" /></svg>;
    case "clock":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    case "star":
    case "starFilled":
      return <svg {...common} fill={name === "starFilled" ? "currentColor" : "none"}><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" /></svg>;
    case "plusCircle":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></svg>;
    case "image":
      return <svg {...common}><rect x="4" y="5" width="16" height="14" rx="2" /><path d="m4 16 4-4 4 4 3-3 5 5" /><circle cx="15" cy="9" r="1" /></svg>;
    case "cloudUpload":
    case "cloud":
      return <svg {...common}><path d="M17.5 18H8a5 5 0 1 1 1-9.9 6 6 0 0 1 11.4 2.4A4 4 0 0 1 17.5 18Z" />{name === "cloudUpload" ? <path d="M12 16V9m0 0-3 3m3-3 3 3" /> : null}</svg>;
    case "open":
      return <svg {...common}><path d="M14 4h6v6" /><path d="m10 14 10-10" /><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" /></svg>;
    case "terminal":
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m7 10 3 2-3 2M12 15h5" /></svg>;
    case "server":
      return <svg {...common}><rect x="5" y="4" width="14" height="6" rx="2" /><rect x="5" y="14" width="14" height="6" rx="2" /><path d="M8 7h.01M8 17h.01" /></svg>;
    case "logs":
      return <svg {...common}><path d="M7 4h10v16H7z" /><path d="M10 8h4M10 12h4M10 16h3" /></svg>;
    case "refresh":
      return <svg {...common}><path d="M20 12a8 8 0 0 1-14 5" /><path d="M4 12a8 8 0 0 1 14-5" /><path d="M18 3v4h-4M6 21v-4h4" /></svg>;
    case "stop":
      return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>;
    case "download":
      return <svg {...common}><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></svg>;
    case "github":
      return <svg {...common}><path d="M12 2a10 10 0 0 0-3 19c.5.1.7-.2.7-.5v-2c-2.8.6-3.4-1.2-3.4-1.2-.5-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 0 1.6 1 1.6 1 .9 1.5 2.4 1.1 2.9.8.1-.7.4-1.1.7-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7 3.6 3.6 0 0 1 .1-2.6s.8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1a3.6 3.6 0 0 1 .1 2.6 3.9 3.9 0 0 1 1 2.7c0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.8v2.7c0 .3.2.6.8.5A10 10 0 0 0 12 2Z" /></svg>;
    default:
      return <svg {...common}><circle cx="12" cy="12" r="8" /></svg>;
  }
}

export function App() {
  const {
    config,
    customBookmarks,
    status,
    history,
    connections,
    lastRefreshAt,
    diagnostics,
    events,
    alertRules,
    refreshRuntime,
    addBookmark,
    updateBookmark,
    importBookmarks,
    removeBookmark,
    resetCustomBookmarks,
    updateConfig,
    organizeBookmarks,
    syncWebContainerBookmarks,
    updateConnections,
    createBackup,
    restoreBackup,
    importBackup,
    clearEvents,
    addAuditEvent,
    updateAlertRules
  } = useRuntime();
  const [addOpen, setAddOpen] = useState(false);
  const [editingBookmark, setEditingBookmark] = useState<Bookmark | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [wallpaperOpen, setWallpaperOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [authToken, setAuthToken] = useState(() => window.localStorage.getItem(authTokenKey) || "");
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ configured: true, required: true, authenticated: false });
  const [theme, setTheme] = useState<ThemeId>(() => {
    const saved = window.localStorage.getItem("hometab.theme.v2");
    return saved === "liquid" || saved === "cyber" || saved === "hacker" || saved === "pixel" || saved === "hud" ? saved : "liquid";
  });
  const [activeCategory, setActiveCategory] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [localBookmarkOrder, setLocalBookmarkOrder] = useState<string[]>(() => config.bookmarkOrder || []);
  const bookmarkOrder = localBookmarkOrder.length ? localBookmarkOrder : config.bookmarkOrder;
  const bookmarks = sortBookmarksByOrder([...customBookmarks, ...config.bookmarks.filter((bookmark) => bookmark.name !== "添加")], bookmarkOrder);

  useEffect(() => {
    setLocalBookmarkOrder(config.bookmarkOrder || []);
  }, [config.bookmarkOrder]);

  async function refreshAuthStatus(token = authToken) {
    const response = await fetch("/api/auth/status", { headers: authHeaders(token) });
    const next = (await response.json()) as AuthStatus;
    setAuthStatus(next);
    if (!next.configured) setSetupOpen(true);
    return next;
  }

  useEffect(() => {
    void refreshAuthStatus();
  }, []);

  async function login(password: string) {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json() as { token: string };
    setAuthToken(payload.token);
    window.localStorage.setItem(authTokenKey, payload.token);
    setAuthOpen(false);
    await refreshAuthStatus(payload.token);
    notify("已解锁管理操作。");
  }

  async function setupPassword(password: string) {
    const response = await fetch("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(authToken) },
      body: JSON.stringify({ password })
    });
    if (!response.ok) throw new Error(await response.text());
    setSetupOpen(false);
    notify("管理密码已设置，请登录后操作。");
    await refreshAuthStatus();
    setAuthOpen(true);
  }

  function requireAuth() {
    if (!authStatus.required || authStatus.authenticated) return true;
    setAuthOpen(true);
    notify("请先输入管理密码。");
    return false;
  }

  function notify(message: string) {
    setNotice(message);
  }

  function selectCategory(category: string) {
    setActiveCategory(category);
    setSearchQuery("");
  }

  function runSearch() {
    const query = searchQuery.trim();
    if (!query) return;
    const direct = bookmarks.find((bookmark) => `${bookmark.name} ${bookmark.url}`.toLowerCase().includes(query.toLowerCase()));
    if (direct) {
      openUrl(direct.url);
      return;
    }
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    openUrl(searchUrl);
  }

  async function saveBookmark(bookmark: Bookmark) {
    if (!editingBookmark) {
      await addBookmark(bookmark);
      notify("网址已添加。");
      return;
    }

    const isDefaultBookmark = config.bookmarks.some((item) => item.url === editingBookmark.url);
    if (isDefaultBookmark) {
      await updateConfig({
        ...config,
        bookmarks: config.bookmarks.map((item) => (item.url === editingBookmark.url ? bookmark : item))
      });
    } else {
      await updateBookmark(editingBookmark.url, bookmark);
    }
    notify("书签已更新。");
  }

  function updateTheme(next: ThemeId) {
    setTheme(next);
    window.localStorage.setItem("hometab.theme.v2", next);
  }

  return (
    <main className={`app-shell app-shell--${theme}`}>
      <Sidebar
        onHome={() => {
          setActiveCategory("");
          setSearchQuery("");
          notify("已回到首页。");
        }}
        onBookmarks={() => selectCategory("")}
        onAdd={() => setAddOpen(true)}
        onImport={() => setImportOpen(true)}
        onWallpaper={() => setWallpaperOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onBackup={() => setBackupOpen(true)}
      />
      <section className="page">
        <TopBar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSearchSubmit={runSearch}
          theme={theme}
          onThemeChange={updateTheme}
          status={status}
          lastRefreshAt={lastRefreshAt}
        />
        <div className="content-grid">
          <BookmarkBoard
            config={config}
            bookmarks={bookmarks}
            activeCategory={activeCategory}
            searchQuery={searchQuery}
            onCategorySelect={selectCategory}
            onAddClick={() => setAddOpen(true)}
            onEditBookmark={setEditingBookmark}
            onRemoveBookmark={(url) => {
              removeBookmark(url);
              notify("自定义书签已删除。");
            }}
            onRemoveBookmarks={(urls) => {
              urls.forEach((url) => {
                void removeBookmark(url);
              });
              notify(`已删除 ${urls.length} 个自定义书签。`);
            }}
            onReorderBookmarks={(nextBookmarks) => {
              setLocalBookmarkOrder(nextBookmarks.map((bookmark) => bookmark.url));
              void organizeBookmarks(nextBookmarks);
              notify("书签顺序已保存。");
            }}
            onMoveBookmarks={(urls, category) => {
              const selected = new Set(urls.map(bookmarkKey));
              const orderedBookmarks = sortBookmarksByOrder([...customBookmarks, ...config.bookmarks.filter((bookmark) => bookmark.name !== "添加")], bookmarkOrder);
              const nextBookmarks = orderedBookmarks.map((bookmark) => (
                selected.has(bookmarkKey(bookmark.url)) ? { ...bookmark, category } : bookmark
              ));
              void organizeBookmarks(nextBookmarks);
              setActiveCategory(category);
              notify(`已移动 ${urls.length} 个书签到 ${category}。`);
            }}
          />
          <SystemCards
            config={config}
            status={status}
            history={history}
            diagnostics={diagnostics}
            events={events}
            lastRefreshAt={lastRefreshAt}
            onRefreshRuntime={refreshRuntime}
            onSyncWebBookmarks={syncWebContainerBookmarks}
            authToken={authToken}
            authStatus={authStatus}
            onRequireAuth={requireAuth}
            onAuthExpired={() => {
              setAuthStatus((current) => ({ ...current, authenticated: false }));
              setAuthOpen(true);
            }}
            onClearEvents={clearEvents}
            onAuditEvent={addAuditEvent}
            onNotice={notify}
          />
        </div>
      </section>
      <AddBookmarkDialog
        open={addOpen || Boolean(editingBookmark)}
        categories={config.categories}
        defaultCategory={activeCategory || "常用"}
        initialBookmark={editingBookmark}
        onClose={() => {
          setAddOpen(false);
          setEditingBookmark(null);
        }}
        onAdd={(bookmark) => {
          saveBookmark(bookmark);
          setAddOpen(false);
          setEditingBookmark(null);
        }}
      />
      <ImportBookmarksDialog
        open={importOpen}
        categories={config.categories}
        defaultCategory={activeCategory || "常用"}
        onImport={async (items) => {
          await importBookmarks(items);
          notify(`已导入 ${items.length} 个书签。`);
        }}
        onClose={() => setImportOpen(false)}
      />
      <WallpaperDialog open={wallpaperOpen} wallpaper={theme} onChange={updateTheme} onClose={() => setWallpaperOpen(false)} />
      <SettingsDialog
        open={settingsOpen}
        config={config}
        connections={connections}
        alertRules={alertRules}
        customCount={customBookmarks.length}
        allBookmarks={bookmarks}
        authToken={authToken}
        authStatus={authStatus}
        onSave={updateConfig}
        onOrganizeBookmarks={organizeBookmarks}
        onSaveConnections={updateConnections}
        onSaveAlertRules={updateAlertRules}
        onRefreshRuntime={refreshRuntime}
        onRequireAuth={requireAuth}
        onAuthExpired={() => {
          setAuthStatus((current) => ({ ...current, authenticated: false }));
          setAuthOpen(true);
        }}
        onResetBookmarks={async () => {
          await resetCustomBookmarks();
          notify("自定义书签已清空。");
        }}
        onClose={() => setSettingsOpen(false)}
      />
      <BackupDialog open={backupOpen} onExport={createBackup} onImport={importBackup} onRestore={restoreBackup} onClose={() => setBackupOpen(false)} />
      <AuthDialog open={authOpen} onLogin={login} onClose={() => setAuthOpen(false)} />
      <SetupWizard open={setupOpen} onSetup={setupPassword} onClose={() => setSetupOpen(false)} />
      <Notice message={notice} onClose={() => setNotice("")} />
    </main>
  );
}
