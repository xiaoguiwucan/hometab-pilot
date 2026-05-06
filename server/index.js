import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
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
const backupDir = path.join(dataDir, "backups");
const port = Number(process.env.PORT || 8080);

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

async function buildBackupPayload() {
  const [config, customBookmarks] = await Promise.all([getConfig(), getBookmarks()]);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    config,
    customBookmarks
  };
}

async function pruneBackups(keep = 7) {
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
        .slice(keep)
        .map((file) => fs.rm(path.join(backupDir, file.name), { force: true }))
    );
  } catch {
    // Missing backup directory is created on the first snapshot.
  }
}

async function createBackupSnapshot(payload) {
  await fs.mkdir(backupDir, { recursive: true });
  const backup = payload || (await buildBackupPayload());
  const name = backupFileName(new Date(backup.exportedAt || Date.now()));
  await writeJson(path.join(backupDir, name), backup);
  await pruneBackups(7);
  return { name, ...summarizeBackup(name, backup) };
}

function summarizeBackup(name, payload) {
  return {
    name,
    exportedAt: payload.exportedAt,
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
    return backups.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 7);
  } catch {
    return [];
  }
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

    return {
      available: true,
      source: "fnos-ssh",
      running: services.filter((container) => container.state === "running").length,
      total: services.length,
      services
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
  await createBackupSnapshot(backup);
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
    version: request.body?.version || 1,
    exportedAt: new Date().toISOString(),
    config,
    customBookmarks: nextBookmarks
  });
  response.json({ ok: true, config, customBookmarks: nextBookmarks });
});

app.get("/api/backups", async (_request, response) => {
  response.json({ backups: await listBackupSnapshots() });
});

app.post("/api/backups", async (_request, response) => {
  response.json({ ok: true, backup: await createBackupSnapshot() });
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
  await createBackupSnapshot({ ...current, exportedAt: new Date().toISOString() });
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

app.post("/api/docker/containers/:id/:action", async (request, response) => {
  const allowed = new Set(["start", "stop", "restart"]);
  if (!allowed.has(request.params.action)) {
    response.status(400).json({ error: "Unsupported action" });
    return;
  }

  try {
    await runFnosDocker(`${request.params.action} ${shellQuote(request.params.id)}`);
    response.json({ ok: true });
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
  const allowed = new Set(["start", "shutdown", "reboot", "stop"]);
  const { node, type, vmid, action } = request.params;
  if (!allowed.has(action) || !["qemu", "lxc"].includes(type)) {
    response.status(400).json({ error: "Unsupported PVE action" });
    return;
  }

  try {
    const data = await pveFetch(
      `/nodes/${encodeURIComponent(node)}/${type}/${encodeURIComponent(vmid)}/status/${action}`,
      { method: "POST" }
    );
    response.json({ ok: true, data });
  } catch (error) {
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
