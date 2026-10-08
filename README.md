# AutoBangumi (Node.js Edition)

[Auto_Bangumi](https://github.com/EstrellaXD/Auto_Bangumi) v3.3.6 的 Node.js 1:1 重构版：
后端 Python/FastAPI → **NestJS + Drizzle ORM (better-sqlite3)**，前端 Vue3 → **React 18 + Ant Design 5**。

## 目录结构

```
autobangumi-node/
├── apps/
│   ├── backend/          # NestJS 后端（Python module/ 的 1:1 移植）
│   └── webui/            # React + AntD 前端（Vue webui 的 1:1 移植）
└── packages/
    └── types/            # 前后端共享 API 契约类型（snake_case，与 Python 序列化一致）
```

## 开发

```bash
pnpm install

# 后端（:7892，首跑自动生成 config_dev.json / data.db，默认账号 admin/adminadmin）
pnpm dev:backend

# 前端（:5173，代理 /api /posters 到后端）
pnpm dev:webui

# 类型检查 / 构建
pnpm typecheck
pnpm build
```

## 功能覆盖（一期 1:1）

| 模块 | 状态 |
|---|---|
| 配置系统（Settings/环境变量/旧配置迁移/掩码还原） | ✅ |
| 数据库（13 表 + 24 个表驱动迁移 + 全部仓储） | ✅ |
| 鉴权（Cookie 会话 / API&MCP token / WebAuthn Passkey / IP 白名单） | ✅ |
| 标题解析（classic + tokenizer 双引擎，与 Python 96/96 对拍一致） | ✅ |
| TMDB / Mikan / bgm.tv 放送表 / 偏移检测 | ✅ |
| LLM 解析（openai/anthropic/gemini + 国产预设 + 订阅授权流程） | ✅（插件安装器二期） |
| 下载器（qBittorrent 4.x/5.x、aria2、mock；凭据闩锁；单飞登录） | ✅ |
| RSS 引擎（聚合解析、匹配、偏好去重、同 host 限速） | ✅ |
| Renamer（pn/advance/字幕/电影/偏移 + rename_operation 持久化状态机 + V1→V2 替换 saga） | ✅ |
| 通知（8 渠道 + 9 种系统事件 + 站内通知中心） | ✅ |
| 周期任务（rss/rename/offset_scan/calendar/update_check） | ✅ |
| REST API（/api/v1 全部 17 个路由模块）+ SSE 聚合流 | ✅ |
| 首启向导（SSRF 防护） | ✅ |
| React WebUI（Ant Design，全部页面） | ✅ |

## 二期（未实现，刻意后置）

- MCP server（/mcp）
- 在线更新（验签下载/apply/rollback + boot_overlay）；`/api/v1/update/*` 端点保留并返回"不可用"
- LLM 插件安装器（签名 zip 安装）；providers 注册表已留插件层接口
- 3.0/3.1 旧数据迁移（data.json → SQLite）
- Dockerfile / entrypoint 覆盖层机制

## 数据兼容

`data/data.db` 与 Python 版完全同构：表结构、索引、迁移框架（24 个迁移带守卫，
schema_version 跟踪）、存储格式（TIMESTAMP 文本、UTC ISO 字符串）均一致，
可以直接使用现有 Python 版的数据库文件。

## 环境变量

与 Python 版一致：`AB_INTERVAL_TIME`、`AB_RENAME_FREQ`、`AB_WEBUI_PORT`、
`AB_DOWNLOADER_HOST/USERNAME/PASSWORD`、`AB_DOWNLOAD_PATH`、`AB_RSS_COLLECTOR`、
`AB_NOT_CONTAIN`、`AB_LANGUAGE`、`AB_RSS_PARSER_ENGINE`、`AB_RENAME`、`AB_METHOD`、
`AB_GROUP_TAG`、`AB_EP_COMPLETE`、`AB_REMOVE_BAD_BT`、`AB_REVISION_CONFLICT_POLICY`、
`AB_DEBUG_MODE`、`AB_HTTP_PROXY`、`AB_SOCKS`、`IPV6`、`AB_DEV_NO_AUTH`（开发鉴权旁路）。
敏感配置值支持 `$VAR` 展开（读取时展开）。
