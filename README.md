# koishi-plugin-dyks-parser

抖音 / 快手链接解析插件（对接自建 [Media-Parser](https://github.com/ucmao/media-parser) 后端，免费、无水印）。

监听消息里的抖音 / 快手分享链接，调用本地解析服务，把视频或图集发到群里，支持合并转发。

> 解析能力不在 Koishi 侧：本插件只负责识别链接、调后端、发送媒体。后端是一个纯 Python 的本地解析服务，解析公开 UGC 内容，不走付费云网关，不需要平台官方 API。

## 特性

- 自动识别抖音（`douyin.com` / `iesdouyin.com` / `v.douyin.com` 短链）和快手（`kuaishou.com` / `v.kuaishou.com` 短链）链接
- **默认不解析引用消息**，也不会从合并转发（聊天记录）里抠链接；需要解析引用时开 `parseQuote`（仍会自动跳过转发消息）
- 视频直链转发（或下载后发送）、图集、封面、标题 / 作者 / 简介
- **合并转发**：与 [`koishi-plugin-bilibili-videolink-analysis`](https://www.npmjs.com/package/koishi-plugin-bilibili-videolink-analysis) 同款 `figure` + `message` 节点打包；失败自动降级为逐条发送
- 同链接去重、请求超时、解析失败提示
- `command` 模式可让插件只响应以指定前缀开头的消息
- 兼容 Koishi 4.18+ 的 `ctx.http`（直接返回响应体）与旧版 axios（`{ data }`）两种形态

## 前置：部署 Media-Parser 后端

插件本身不含解析逻辑，需要先跑一个后端（纯 API 模式）：

```bash
git clone https://github.com/ucmao/media-parser.git
cd media-parser
```

`.env` 至少包含：

```ini
API_ONLY=true
TZ=Asia/Shanghai
```

启动（二选一）：

```bash
# Docker
docker compose up -d --build

# 或直接 Python（3.10+）
pip install -r requirements.txt
python app.py
```

默认监听 `8051`，验证：

```bash
curl "http://127.0.0.1:8051/api/health"
# {"status":"ok"}
```

抖音常规短视频 / 图集、快手常规短视频都支持匿名解析；触发风控时再按需在后端 `.env` 里配 `DOUYIN_COOKIE` / `KUAISHOU_COOKIE`。

## 安装

把本目录放到 Koishi 工作区（例如 `external/koishi-plugin-dyks-parser`），然后在 `koishi.yml` 启用：

```yaml
plugins:
  dyks-parser:
    endpoint: http://127.0.0.1:8051
```

> **配置 key 必须写短名 `dyks-parser`**，不要写 `koishi-plugin-dyks-parser`：Koishi 控制台的插件页会自己拼 `koishi-plugin-` 前缀，写全名会拼成 `koishi-plugin-koishi-plugin-...`，控制台显示"此插件尚未安装"（插件本身仍能加载，但无法在控制台改配置）。

Koishi 与后端不在同一台机器时，把 `endpoint` 换成后端实际地址；Koishi 跑在 Docker 容器里、后端跑在宿主机时，用宿主机 docker 网关地址（通常是 `http://172.17.0.1:8051` 或 `http://172.18.0.1:8051`）。

## 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:8051` | Media-Parser 服务地址，末尾不要带斜杠 |
| `apiKey` | 空 | API Key；后端 `API_ONLY=true` 时留空 |
| `enableDouyin` | `true` | 解析抖音链接 |
| `enableKuaishou` | `true` | 解析快手链接 |
| `useForward` | `true` | 合并转发（仅 onebot / napcat / red / yunhu / telegram / discord；失败自动降级逐条发送） |
| `forwardNickname` | 空 | 合并转发节点昵称；留空用发链接用户的昵称 |
| `videoMode` | `url` | `url` 直链转发；发不出去时改 `buffer` 先下载再发 |
| `sendInfo` | `true` | 发送标题 / 作者 / 平台 / 简介 / 原链接 |
| `sendCover` | `false` | 发送封面图 |
| `showWaiting` | `true` | 显示"正在解析…"提示 |
| `maxImages` | `9` | 图集最多发送张数 |
| `timeout` | `60000` | 请求超时（毫秒） |
| `dedupeSeconds` | `30` | 同一链接去重秒数，0 为不去重 |
| `parseQuote` | `false` | 解析引用消息里的链接（默认关闭；开启后仍会自动跳过合并转发 / 聊天记录） |
| `command` | 空 | 仅响应以此开头的消息（如 `dyks`）；留空则自动识别所有消息 |

## 发送格式

开启 `useForward` 时，一条链接的内容会打成一个合并转发消息，每个节点依次是：

1. 文字：标题 / 作者 / 平台 / 简介（与标题重复时省略，超 200 字截断）/ 原分享链接
2. 封面图（`sendCover: true` 时）
3. 视频，或图集（最多 `maxImages` 张）

合并转发节点作者是发链接的用户（可用 `forwardNickname` 覆盖）。当平台不支持合并转发、或转发发送失败时，自动改为逐条发送；单条视频发送失败会补发「视频发送失败，直链：…」。

## 依赖与兼容

- `peerDependencies`: `koishi ^4.18.0`
- 不声明任何 npm 依赖，`require('koishi')` 从 Koishi 工作区解析
- 发送视频直链时由适配器自己去拉取；如果适配器拉不动直链，把 `videoMode` 改为 `buffer`

## 边界

只解析平台公开的 UGC 短视频 / 图集。不解析 VIP、付费、会员专享、版权长视频，不做 DRM 绕过。后端解析接口来自平台网页端的公开接口，存在被风控的可能，触发时按后端文档配置对应平台的 Cookie 即可。

## 致谢

- [**ucmao/media-parser**](https://github.com/ucmao/media-parser)（MIT）：**本插件不自带任何解析能力**，抖音 / 快手的链接解析全部由这个后端项目完成。本插件只调用它的 HTTP 接口，不包含、也不修改它的代码（由使用者自行部署）。
- [**koishi-plugin-bilibili-videolink-analysis**](https://www.npmjs.com/package/koishi-plugin-bilibili-videolink-analysis)（MIT）：合并转发的发送样式（`figure` + `message` 节点、消息结构）参考了它的实现。
- [**Koishi**](https://koishi.chat/)：插件框架。

本插件自身以 MIT 协议发布，见 [LICENSE](./LICENSE)。

## License

MIT
