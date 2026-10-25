# Bruno Web

在浏览器里使用 [Bruno](https://github.com/usebruno/bruno) API 客户端。集合文件存在服务器上，请求从服务器发出。

做法：不改 Bruno 的任何源码。Bruno 桌面版的主进程代码原样运行在 Node 22 里，用一个假的 `electron` 模块替代 Electron；
Bruno 的前端构建产物原样提供给浏览器，前面注入一个用 WebSocket 实现的 `window.ipcRenderer`。设计与取舍见 [docs/DESIGN.md](docs/DESIGN.md)。

## 快速开始（本机）

需要 Node 22.13 以上、git。

```bash
npm install
scripts/fetch-upstream.sh          # 按 UPSTREAM_COMMIT 拉取并构建 Bruno（约 3 分钟）
BRUNO_WEB_AUTH=none npm start      # 只监听 127.0.0.1:8484，免登录
```

打开 http://127.0.0.1:8484 。

## Docker

```bash
docker build -t bruno-web .
docker run -d -p 8484:8484 -v bruno-data:/data \
  -e BRUNO_WEB_PASSWORD='换成你的密码' \
  -e BRUNO_WEB_SECRET_KEY='换成一串随机值' \
  bruno-web
```

容器以 uid 1000 运行，所有数据在 `/data`：`userData/`（偏好、Cookie、OAuth2 token）、`workspace/`（集合）、`uploads/`（从浏览器上传的文件）。

部署后访问 `/bruno-web/selfcheck`（需登录）：返回 200 才算部署成功。它会真实执行一次脚本沙箱、SQLite 读写、通过 Bruno 的 HTTP 客户端发一次请求，并核对前端用到的每个通道服务端都有处理。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8484` / `127.0.0.1` | 监听地址（镜像里 `HOST=0.0.0.0`） |
| `BRUNO_WEB_DATA` | `./data` | 数据目录 |
| `BRUNO_WEB_ROOTS` | `$BRUNO_WEB_DATA/workspace` | 文件对话框可浏览的目录，多个用 `:` 分隔 |
| `BRUNO_WEB_AUTH` | `password` | `password`、`proxy`（由反向代理认证）、`none`（仅限回环地址） |
| `BRUNO_WEB_PASSWORD` / `BRUNO_WEB_PASSWORD_HASH` | | 登录密码，或 `scrypt$盐$哈希` 形式的哈希 |
| `BRUNO_WEB_PROXY_USER_HEADER` / `BRUNO_WEB_PROXY_SECRET_HEADER` / `BRUNO_WEB_PROXY_SECRET` | | `proxy` 模式：用户名头、共享密钥头与密钥 |
| `BRUNO_WEB_PUBLIC_URL` | | 对外地址（如 `https://bruno.example.com`）；设置后只接受来自它的页面，OAuth2 回调地址也据此生成 |
| `BRUNO_WEB_TRUST_PROXY` | `false` | 信任 `X-Forwarded-*` 头 |
| `BRUNO_WEB_SECRET_KEY` | 自动生成到 `userData/` | 加密保存密钥类数据的主密钥 |
| `BRUNO_WEB_ALLOW_DEVELOPER_MODE` | `false` | 允许脚本「开发者模式」和安装 npm 包——等于允许在服务器上执行任意代码 |
| `BRUNO_WEB_ENABLE_TERMINAL` | `false` | 内置终端——等于给浏览器一个服务器 shell |
| `BRUNO_WEB_BLOCK_METADATA` | `true` | 拒绝连接 169.254.0.0/16 等云元数据地址（尽力而为，见下） |
| `BRUNO_WEB_SAMPLE_COLLECTION` | `true` | 首次启动导入示例集合 |
| `BRUNO_WEB_SESSION_TTL_HOURS` | `12` | 登录有效期（有操作就顺延） |

所有 `BRUNO_WEB_*` 变量读入后会从进程环境中删除，集合脚本（`bru.getProcessEnv()`）读不到它们。

## 安全须知

- **一个实例给一个人（或一个互相信任的小组）用。** 多人使用请每人一个容器，由统一登录网关按用户路由。
- 请求从服务器发出，`localhost` 指服务器自己，能访问服务器所在网段。请用防火墙或 K8s NetworkPolicy 约束容器出站。
- 文件根目录只限制文件对话框的浏览范围；进程能读写该用户（uid 1000）能访问的一切文件，真正的边界是容器。
- 不要把平台凭据放进容器的环境变量（脚本能读到除 `BRUNO_WEB_*` 外的环境变量）。

## 与桌面版的差异

| 场景 | 网页版 |
| --- | --- |
| 选文件/文件夹 | 网页里的服务器文件浏览器；可从本机上传 |
| 导出 | 可选「下载到本机」或「保存到服务器」 |
| OAuth2 登录 | 在弹窗里登录；回调地址设为 `<对外地址>/bruno-web/oauth2/callback` 可自动完成（含隐式授权），否则把回跳地址粘贴回 Bruno。无法为授权页注入自定义请求头，也不能按 Bruno 设置忽略证书错误 |
| Bruno Apps | 运行在不透明源的沙箱 iframe 里，没有 localStorage 等存储，所有 App 的 origin 都是 `null` |
| 多个标签页 | 同一时刻只有一个标签页可用，新标签页会接管 |
| 脚本开发者模式、终端、npm 安装 | 默认关闭 |

## 测试

```bash
npm test                                             # 单元测试
npx playwright test -c test/e2e/playwright.config.js # 网页版特有行为（文件对话框、断线恢复、接管、OAuth2、安全策略）
scripts/upstream-e2e.sh --project=default            # 在网页版上运行 Bruno 上游自己的整套端到端测试
```

`scripts/upstream-e2e.sh` 原样使用上游的测试和测试夹具，只把「启动 Electron 应用」换成「启动 Bruno Web 服务 + 浏览器标签页」。整套测试较吃内存（每个并行约 1.5 GB），用 `E2E_WORKERS` 控制并行数。

## 升级 Bruno

改 `UPSTREAM_COMMIT` → `scripts/fetch-upstream.sh` → 看 `/bruno-web/selfcheck` 的通道覆盖和「未实现 Electron API」两项 → 跑上面三组测试。
