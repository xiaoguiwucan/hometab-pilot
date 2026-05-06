# HomeTab Pilot v0.2.0

这是 HomeTab Pilot 的第一个正式功能版本，重点从“导航页”升级为“NAS / Homelab 运维首页”。

## 功能新增

- 飞牛 OS Docker Web 容器自动发现：一键把有 Web 访问地址的容器同步到 `NAS` 书签分组。
- Web 服务健康检查：容器访问地址显示 HTTP 状态和延迟，帮助快速判断服务是否真的可访问。
- Docker 容器管理：展示真实容器 CPU、内存、网络、端口、日志、配置、健康状态和重启策略。
- 容器操作：支持查看日志、查看配置、重启、停止，危险操作带确认。
- PVE 管理：展示 QEMU / LXC 实例，并支持启动、关机、重启、强停。
- 连接诊断：显示 FNOS Web、FNOS SSH、Docker、PVE API 的实时连通状态。
- 事件中心：记录告警、恢复和 Docker / PVE 操作历史。
- 多主题 UI：macOS 流体玻璃、赛博朋克、黑客代码、16 比特动画、Future White HUD。
- 书签管理：新增、右键编辑、批量导入、分类移动、拖拽排序、自动 Logo。
- 备份恢复：支持配置和自定义书签导出、导入、服务端备份快照。

## 优化与修复

- 优化任意分辨率下的自适应布局，减少拥挤和横向溢出。
- 优化 Docker 容器表格结构，使行选择和操作按钮分离。
- 优化日志弹窗可读性，清理 ANSI 控制字符。
- 优化局域网容器 Logo 策略，避免 favicon 404 噪音。
- 修复分类管理可能导致左侧默认书签被清空的问题。
- 修复危险容器操作缺少二次确认的问题。
- 修复弹窗焦点管理、Escape 关闭和焦点恢复体验。

## Docker 镜像

```bash
docker pull xiaoguiwucan0426/hometab-pilot:0.2.0
docker pull xiaoguiwucan0426/hometab-pilot:latest
```

支持平台：

- `linux/amd64`
- `linux/arm64`

## 快速部署

```bash
docker run -d \
  --name hometab-pilot \
  --restart unless-stopped \
  -p 8088:8080 \
  -v hometab-data:/data \
  --env-file .env \
  xiaoguiwucan0426/hometab-pilot:0.2.0
```
