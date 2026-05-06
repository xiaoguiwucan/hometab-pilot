# HomeTab Pilot

一个以书签网站导航为主、兼容飞牛 OS / PVE / Docker 容器管理入口的新标签页项目。支持书签管理、主题切换、运行时备份恢复，以及通过飞牛 OS SSH / PVE API 读取真实设备和容器状态。

## 功能

- iTab 风格书签导航：首页中心是 5x3 常用网站入口。
- 分类标签：常用、NAS、AI、下载、影音、开发、工具、生活。
- 左侧导航：添加网址、导入书签、主题、设置、备份等常用操作集中在侧栏。
- 右侧管理：飞牛 OS、PVE、Docker 容器状态与快捷动作。
- 运行时配置：支持页面设置、数据卷持久化和备份恢复。
- 官方 Logo：默认服务优先使用品牌 SVG / 官方 favicon，不再使用手绘替代图标。
- 自动取 Logo：点击“添加”后粘贴网址，会自动尝试从 favicon / Apple touch icon / favicon 服务提取 Logo。
- 可用交互：分类筛选、搜索直达/网页搜索、组件显示开关、壁纸切换、运行时设置、备份导入导出。
- 书签管理：添加、删除、右键编辑、批量导入；自定义书签保存到后端数据卷，静态预览时回退到浏览器 localStorage。
- Docker 部署：支持 x86_64 / arm64，适合 PVE、飞牛 OS、NAS、软路由环境。
- 后端 API：同一容器提供 `/api/runtime`、书签持久化、运行时配置保存、备份恢复、飞牛 OS Docker 容器列表/日志/操作、PVE API 代理。

## 本地开发

```bash
npm install
npm run dev
```

访问 `http://localhost:5173`。

## Docker 部署

```bash
docker compose up -d --build
```

访问 `http://服务器IP:8088`。

部署后会创建：

- Web 服务：`hometab-pilot`
- 访问端口：`8088`
- 数据卷：`hometab-data`
- Docker 管理：通过飞牛 OS SSH 读取和操作远端容器

## 真实管理配置

复制并编辑 `.env`：

```bash
cp .env.example .env
```

```bash
PVE_URL=https://你的PVE地址:8006
PVE_USERNAME=root@pam
PVE_PASSWORD=你的密码
PVE_TLS_VERIFY=false
FNOS_URL=http://你的飞牛OS地址
FNOS_SSH_HOST=你的飞牛OS地址
FNOS_SSH_USERNAME=你的用户名
FNOS_SSH_PASSWORD=你的密码
```

修改后重启：

```bash
docker compose up -d
```

注意：PVE 和飞牛 OS 的账号密码不要写进 `public/config.json`，它会被前端访问；敏感信息只放 `.env` 或页面“设置”里的连接配置。页面不会回显已保存的密码。

当前后端支持：

- PVE：账号密码登录或 API Token 登录，读取节点、VM、LXC 数据。
- 飞牛 OS：HTTP 连通检测，SSH 读取 CPU、内存、根分区磁盘占用。

## 多架构镜像

构建同时支持 x86 和 ARM 的镜像：

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t your-registry/hometab-pilot:latest \
  --push .
```

如果只在本机使用：

```bash
docker build -t hometab-pilot:latest .
docker run -d --name hometab-pilot --restart unless-stopped -p 8088:8080 hometab-pilot:latest
```

## 发布到 Docker Hub

本仓库内置 GitHub Actions 工作流：推送到 `main` 后会构建并发布多架构镜像。

在 GitHub 仓库设置 `Settings -> Secrets and variables -> Actions` 中添加：

- `DOCKERHUB_USERNAME`：Docker Hub 用户名
- `DOCKERHUB_TOKEN`：Docker Hub Access Token

然后推送 `main` 分支即可发布：

```bash
git push -u origin main
```

手动本地发布：

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t DOCKERHUB_USERNAME/hometab-pilot:latest \
  --push .
```

## 配置书签

编辑 `public/config.json`，可以调整：

- `categories`：顶部分类。
- `bookmarks`：中心书签图标。
- `folders`：左侧文件夹。
- `recent`：最近访问。
- `favorites`：今日收藏。
- `systems`：飞牛 OS、PVE、容器状态展示。

每个书签支持 `logoUrl` 字段。建议优先填写官方 favicon 或官方 Logo 图片地址；如果不填，添加网址流程会按目标站点自动尝试提取。

页面右下“设置”可以直接编辑运行时 JSON 配置。Docker 部署时配置会保存到 `hometab-data` 数据卷，不会覆盖镜像内的默认 `config.json`。

书签卡片支持：

- 左键：打开网址。
- 右键：编辑名称、地址、分类和 Logo。
- 悬停按钮：编辑或删除自定义书签。

页面右下“导入书签”支持粘贴 JSON 数组，或每行一个 `名称 URL`。

## 备份与恢复

页面右下“备份”支持：

- 导出：下载包含配置和自定义书签的 JSON 文件。
- 导入：恢复导出的 JSON 文件，部署模式会写入数据卷，静态预览模式会写入浏览器本地存储。

## Logo 提取策略

静态部署环境无法稳定跨域读取网站 HTML，所以自动提取使用浏览器可直接加载的图片候选：

- 书签配置里的 `logoUrl`
- 目标站点 `/favicon.ico`
- 目标站点 `/apple-touch-icon.png`
- Google S2 favicon 服务
- DuckDuckGo icon 服务

常见品牌图标使用 `simple-icons` 内置 SVG，以减少外链失败和图标变形。

## 后续接入建议

- 飞牛 OS：后端读取系统状态、存储池、应用和 Docker 状态。
- PVE：使用 Proxmox VE API Token 读取节点、VM、LXC、备份任务。
- Docker：通过飞牛 OS SSH 执行容器列表、日志、重启、停止等操作。
- 安全：管理动作需要登录、权限分级和二次确认；Token 不进入前端静态文件。
