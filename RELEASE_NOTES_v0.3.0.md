# HomeTab Pilot v0.3.0

v0.3.0 是安全与运维增强版本，把登录鉴权、通知告警、容器更新中心、首次配置向导和审计导出合并到一个版本中。

## 功能新增

- 登录鉴权：首次配置向导设置管理密码，Docker/PVE 危险操作需要登录解锁。
- 通知告警：支持 Bark、Telegram、企业微信机器人、Server 酱和通用 Webhook，关键告警可主动推送。
- 通知设置面板：可在设置中启用推送、录入通道密钥，并发送测试通知。
- 容器更新中心：支持检查镜像、拉取镜像、重建容器，并在操作前保存配置备份。
- 容器配置备份：Docker 操作前自动保存 inspect 配置，便于后续回滚。
- 权限/审计：服务端记录登录、Docker/PVE 操作、通知配置等审计事件。
- 审计导出：事件中心支持导出服务端审计 JSON。

## Docker 镜像

```bash
docker pull xiaoguiwucan0426/hometab-pilot:0.3.0
docker pull xiaoguiwucan0426/hometab-pilot:v0.3.0
docker pull xiaoguiwucan0426/hometab-pilot:latest
```

## 快速部署

```bash
docker run -d \
  --name hometab-pilot \
  --restart unless-stopped \
  -p 8088:8080 \
  -v hometab-data:/data \
  --env-file .env \
  xiaoguiwucan0426/hometab-pilot:0.3.0
```

## 通知环境变量

```bash
NOTIFY_ENABLED=true
BARK_URL=
SERVER_CHAN_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
WECOM_WEBHOOK_URL=
NOTIFY_WEBHOOK_URL=
```
