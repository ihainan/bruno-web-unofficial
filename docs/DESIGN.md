# Bruno Web 设计方案

> 版本：v1（2026-10-25）。上游基线：`usebruno/bruno@ab6e3efa`（2026-10-24），MIT 协议。
> 上游源码在 `upstream/`（不进本仓库 git，由 `scripts/fetch-upstream.sh` 按 `UPSTREAM_COMMIT` 拉取）。

## 1. 结论

**可以做，而且能做到「上游代码零改动」。** Bruno 桌面版是 Electron 应用，前端（React，`packages/bruno-app`）
和后端（Node 主进程，`packages/bruno-electron`）之间只有一条很窄的通道：前端全部通过 `window.ipcRenderer`
的 5 个方法（`invoke / send / on / getFilePath / openExternal`）调用主进程；主进程的全部能力都是
`registerXxxIpc(mainWindow)` 往 `ipcMain` 上挂的处理函数（约 256 个通道），再用 `mainWindow.webContents.send`
往前端推事件（约 48 种）。

所以网页版 = **把主进程代码原样跑在普通 Node 22 里，用一个假的 `electron` 模块顶替真 Electron；
在浏览器里用 WebSocket 实现一个同接口的 `window.ipcRenderer` 顶替 preload。** 不重写任何业务逻辑，
上游升级时只需重新核对接缝。

### 1.1 调研事实（均已在源码中核对）

| 事实 | 位置 | 对方案的意义 |
| --- | --- | --- |
| preload 只暴露 `ipcRenderer`（5 个方法）和 `isPlaywright`、`isBenchmarkBuild` 两个布尔值 | `bruno-electron/src/preload.js` | 前端接缝极窄，注入一个同名对象即可 |
| 前端 230 个 invoke/send/on 通道、主进程 256 个 handle/on 通道、48 种推送事件 | grep 统计 | 不可能重写 REST，必须复用 |
| 主进程 49 个文件 `require('electron')`，实际用到：`ipcMain`、`app`（`getPath('userData'/'documents')`、`getVersion`、`isPackaged`）、`dialog`（10 处）、`BrowserWindow`（主窗口 + OAuth2 登录窗）、`shell`、`session`、`nativeTheme`、`safeStorage`、`protocol`、`screen`、`Menu`、`globalShortcut`、`webUtils` | grep 统计 | 垫片面可控 |
| 13 处 `electron-store`，另有 `electron-is-dev`、`electron-util`、`about-window` | `store/*`、`index.js` | 整包替换 `electron-store`（底层是 `conf`），其余只在入口用，不加载 |
| 脚本沙箱默认 QuickJS（`quickjs-emscripten`，WASM）；集合设为「开发者模式」时走 Node `vm`，可访问 `require` | `ipc/network/index.js:71` `getJsSandboxRuntime` | 开发者模式 = 在服务器上执行任意代码，网页版必须能由服务端强制关闭 |
| 运行时选择依据的是**前端传来的** `collection.securityConfig` | 同上 | 关闭开发者模式不能信前端，要在服务端拦 `@usebruno/js` 的运行时构造 |
| SQLite 用 Node 内置 `node:sqlite` | `bruno-sqlite/src/node/db.ts` | 需要 Node ≥ 22.13（Electron 37 内置的也是 Node 22） |
| 终端用 `@lydell/node-pty`（N-API 预编译包） | `ipc/terminal.js` | 普通 Node 可直接加载；但等于给浏览器一个服务器 shell，默认关闭 |
| 集合索引用 `workerpool` 的 Node worker | `services/pool` | 普通 Node 可用 |
| `webContents.send` 上游已在发送前做一次 JSON 往返 | `index.js:502-513` | 推送事件的序列化语义就是 JSON，照搬即可 |
| 主 HTTP 响应体已转 base64 再返回 | `ipc/network/index.js:1319` | 大头二进制已文本化；其余 invoke 返回值仍可能含 Buffer，需要带类型标记的编码 |
| 前端按 Electron 的报错格式 `Error invoking remote method '<通道>': Error: <消息>` 解析错误 | `utils/common/error.js:43`、`QueryResult/index.js:34`、`collections/actions.js:679` | 桥接层必须逐字复刻这个格式，否则「取消请求」等逻辑会坏 |
| 已在监听的集合再次打开时，只发 `main:collection-opened`，不重发文件树 | `app/collections.js:89` | 浏览器刷新 ≠ 桌面冷启动，新页面接入时必须先关掉旧监听再重放 |
| `<webview>`（Electron 专有标签）用在 3 处：HTML 响应预览、Apps 视图、集合 App | `HtmlPreview.js`、`AppWebviewPane`、`CollectionApp` | 前端注入同名自定义元素，用沙箱 iframe 模拟 |
| Apps 文档走自定义协议 `bruno-app://`（`session.fromPartition().protocol.handle`） | `app/app-documents.js` | 垫片截获 handler，改由 HTTP 路由提供 |
| OAuth2 两种授权方式：内嵌窗口（监听 `will-redirect/did-navigate` 匹配回调地址）、系统浏览器（`bruno://app/oauth2/callback` 深链） | `authorize-user-in-window.js`、`oauth2-protocol-handler.js` | 浏览器无法截获跨域跳转，改为「回调指向本服务」或「用户粘贴回跳地址」 |
| `getFilePath(file)` 是**同步**调用，11 处用于拖放/选择文件取本地路径 | 11 个组件 | 浏览器没有本地路径，改为「同步返回预分配的服务端路径 + 后台上传 + 调用前等上传完成」 |

**官方态度**：上游 issue [#1952](https://github.com/usebruno/bruno/issues/1952)「how do I run bruno locally as a web app?」
（2024-03 提出，标签 `feature-request` + `long-term-goal`，至今开着），贡献者回复是「Bruno 需要访问文件系统，所以只能做桌面端」。
本方案正是把文件系统放到服务端来解决这一点。没有找到官方或成熟的社区网页版（官方 Docker 镜像只有 CLI）。

## 2. 目标与非目标

**目标（一期）**
- 浏览器里使用 Bruno 的完整界面：工作区、集合（`.bru` / YAML 文件夹）、请求编辑与发送（HTTP、GraphQL、gRPC、WebSocket、SSE）、
  环境与全局环境、变量、前后置脚本与测试（安全模式）、集合运行器、导入导出、Cookie、OAuth2、客户端证书、代理、Git、OpenAPI 同步、Mock Server。
- 集合文件存在服务器磁盘上，外部改动（如 `git pull`）实时推到页面。
- 刷新页面、网络闪断后能自动恢复。
- 有登录保护，适合放到内网。
- 单个 Docker 镜像即可部署，带能当场证伪的部署自检。

**非目标（一期不做，后续可加）**
- 同一进程内多用户隔离（见 §4.1，靠「一人一实例」解决）。
- 多个浏览器标签页同时操作同一实例（同一时刻只允许一个活动页面，见 §4.5）。
- 桌面专属体验：系统菜单、窗口缩放快捷键、`bruno://` 深链、系统托盘。
- 内置终端默认关闭（可开，开了即服务器 shell）。

## 3. 架构

```
浏览器                                              服务器（一个用户一个进程/容器）
┌──────────────────────────────────┐   HTTPS   ┌──────────────────────────────────────────────┐
│ 上游 bruno-app 构建产物（不改）     │◀────────▶│ HTTP 层（express）                              │
│                                  │           │  /             静态资源 + 注入 bridge 的 index.html │
│ bruno-web bridge（启动前注入）      │           │  /bruno-web/login  登录                        │
│  • window.ipcRenderer（WS 实现）   │   WS      │  /bruno-web/ws     IPC 通道                    │
│  • 服务端文件浏览/上传/下载对话框     │◀────────▶│  /bruno-web/api/*  文件浏览、上传、下载            │
│  • <webview> 自定义元素（iframe）   │           │  /bruno-web/app-doc/:token  Apps 文档            │
│  • OAuth2 弹窗 / 粘贴回跳地址        │           │  /bruno-web/oauth2/callback OAuth2 回调          │
│  • 连接状态遮罩                     │           │  /bruno-web/healthz, /selfcheck                │
└──────────────────────────────────┘           ├──────────────────────────────────────────────┤
                                               │ 会话管理：单活动页面、断线重放、接管时重置           │
                                               │ IPC 分发：invoke→handler，webContents.send→WS  │
                                               ├──────────────────────────────────────────────┤
                                               │ electron 垫片（模块解析钩子）                     │
                                               │  ipcMain / BrowserWindow / app / dialog / shell │
                                               │  safeStorage / session / protocol / nativeTheme │
                                               │  electron-store → conf                          │
                                               ├──────────────────────────────────────────────┤
                                               │ 上游 bruno-electron/src（不改，按原样 require）    │
                                               │  registerNetworkIpc / registerCollectionsIpc …  │
                                               └──────────────────────────────────────────────┘
                                                        │ 发请求、读写集合文件、git、mock server
                                                        ▼
                                               /data/workspace（集合）  /data/userData（偏好、Cookie、密钥）
```

仓库结构：

```
Bruno-Web/
  UPSTREAM_COMMIT          上游基线 commit
  scripts/fetch-upstream.sh  拉取并构建上游
  server/                  后端（Node 22，CommonJS，和上游主进程同风格）
    index.js               入口：装垫片 → 复刻上游 index.js 的 ready 段 → 起 HTTP/WS
    electron-shim/         假 electron 模块与相关包替身
    session.js             会话管理（单活动页面、事件序号与重放）
    codec.js               WS 消息编码（带类型标记的 JSON）
    auth.js                登录、Cookie、Origin 校验
    fs-api.js              文件浏览 / 上传 / 下载
    policy.js              服务端策略（禁用开发者模式、终端开关、根目录）
    selfcheck.js           部署自检
  web/                     前端注入层（不依赖 React，Shadow DOM 隔离样式）
    bridge.js              window.ipcRenderer 实现 + 重连
    dialogs.js             文件对话框 UI
    webview.js             <webview> 自定义元素
    overlay.js             连接状态 / 被接管 / 登录过期
  test/                    单元测试 + Playwright 端到端
  Dockerfile
```

## 4. 后端设计

### 4.1 进程模型与租户

上游主进程里大量**模块级单例**：`oauth2AuthorizationRequest`、Cookie 存储、偏好、全局环境、终端管理器、Mock Server、
所有 watcher 都绑定一个 `mainWindow`。在一个进程里做多用户隔离要改掉这些单例，等于 fork 上游，不做。

**一期范围：一个实例 = 一个用户（或一个互相信任、共享同一份工作区的小组）。**
多用户的做法是「一人一容器」：K8s 上每个用户一个 StatefulSet（或按需拉起的 Pod），前面由统一登录网关
（院内已有 Keycloak，可经 oauth2-proxy）按用户路由。这是部署层的事，二期再做编排器，本仓库只保证单实例可独立部署、
支持「信任反向代理的认证头」模式。

### 4.2 electron 垫片

服务端入口最先安装模块解析钩子（`Module._resolveFilename`），把以下模块名指到 `server/electron-shim/`：

| 模块 | 替身行为 |
| --- | --- |
| `electron` | 见下表 |
| `electron-store` | 继承 `conf`，`cwd` 固定为 `userData`，保持 `name`、`defaults`、`clearInvalidConfig`、`encryptionKey` 等选项语义 |
| `electron-is-dev` | 导出 `false` |
| `electron-util`、`about-window` | 空实现（入口不加载它们，替身只为保险） |

`electron` 替身：

| API | 替身行为 |
| --- | --- |
| `ipcMain` | `EventEmitter` + `handle/handleOnce/removeHandler`；内部维护 handler 表供分发层调用；`emit` 保留给上游的进程内事件（如 `main:renderer-ready`） |
| `BrowserWindow`（主窗口） | 单例假窗口：`webContents.send(ch, ...args)` → 先按上游语义做 JSON 往返 → 交给会话层推送；`isDestroyed()` 恒 false；`on/once` 可注册（`did-finish-load` 在新页面接入时触发）；最小化/最大化等为空操作 |
| `BrowserWindow`（其它，如 OAuth2 登录窗） | 见 §4.7 |
| `app` | `getPath('userData')` → `$BRUNO_WEB_DATA/userData`；`getPath('documents'/'home'/'temp'/'downloads')` → 数据目录下对应子目录；`getVersion()` → 上游 `bruno-electron/package.json` 版本；`isPackaged` → true；`on/whenReady/quit` 等空实现 |
| `dialog.showOpenDialog / showSaveDialog / showMessageBox` | 通过会话层向**当前活动页面**发起反向 RPC，弹出服务端文件对话框，等用户选完返回与 Electron 相同结构 `{ canceled, filePaths | filePath }` / `{ response }` |
| `shell.openExternal(url)` | 反向 RPC 让页面 `window.open`；被拦截时页面提示可点击的链接；`openPath/showItemInFolder` → 页面提示服务端路径 |
| `safeStorage` | `isEncryptionAvailable()` 为 true；`encryptString/decryptString` 用 AES-256-GCM，主密钥取自 `BRUNO_WEB_SECRET_KEY` 或 `userData/.bruno-web-master-key`（首次生成，权限 0600）。上游密文格式（`$<算法>:<hex>`）不变 |
| `session.fromPartition(p)` / `session.defaultSession` | 返回假 session：`protocol.handle(scheme, fn)` 记录 handler（供 §4.8 的 HTTP 路由调用）；`webRequest.*`、`setPermission*`、`clearStorageData`、`cookies` 等为空实现 |
| `protocol` | `registerSchemesAsPrivileged`、`handle` 记录即可 |
| `nativeTheme` | `themeSource` 可写，`shouldUseDarkColors` 读页面上报的系统主题 |
| `screen`、`Menu`、`globalShortcut`、`webUtils`、`clipboard` | 空实现或最小实现 |

**防漏机制**：垫片用 `Proxy` 包一层，访问任何未实现的属性时记录到 `/bruno-web/selfcheck` 的「未实现 API」清单并打警告日志，
而不是静默返回 `undefined`。上游升级后跑一遍端到端测试即可看到新增的 Electron 依赖。

### 4.3 入口

`server/index.js` 复刻上游 `index.js` 的 `app.on('ready')` 段中**与窗口无关**的部分，顺序保持一致：
初始化 shell 环境、系统代理、偏好 → 创建假主窗口 → 依次调用全部 `registerXxxIpc(...)`（和上游同参数）
→ `sqliteService.openDatabase()`、`clearAllRunnerResponses()`、`registerSqliteIpc()`、`appDocuments.handleProtocol()` 等。
窗口类通道（`renderer:window-*`、`renderer:toggle-devtools`、`renderer:open-about`）由入口注册为空操作或页面侧实现；
缩放类通道（`renderer:set-zoom-level` 等）转成推送，让页面用 CSS `zoom` 实现。

退出时复刻上游 `before-quit` 的清理顺序（关 watcher、卸载 mount、清 runner 响应、回收 SQLite、落盘 Cookie、杀终端），响应 SIGTERM。

**自检**：启动后比对「前端代码里出现的通道名集合」（构建时从 `bruno-app/src` 静态提取，存入产物）与「`ipcMain` 实际注册的通道名」，
缺失的写进 `/bruno-web/selfcheck`。这是上游升级时最直接的接缝检查。

### 4.4 WS 协议与编码

单条 WebSocket：`/bruno-web/ws?sid=<页面会话 id>&last=<已收到的最大事件序号>`。

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| 页面→服务 | `{t:'invoke', id, ch, args}` | 对应 `ipcRenderer.invoke` |
| 服务→页面 | `{t:'result', id, ok:true, value}` / `{t:'result', id, ok:false, error:{message, name, stack?}}` | `message` 已按 Electron 格式包好：`Error invoking remote method '<ch>': <String(err)>` |
| 页面→服务 | `{t:'send', ch, args}` | 对应 `ipcRenderer.send`，无返回 |
| 服务→页面 | `{t:'event', seq, ch, args}` | 对应 `webContents.send`，`seq` 单调递增 |
| 服务→页面 | `{t:'rpc', id, method, params}` | 反向调用：文件对话框、打开外链、OAuth2 窗口、下载、缩放 |
| 页面→服务 | `{t:'rpc-result', id, ok, value|error}` | 反向调用结果 |
| 双向 | `{t:'ping'}` / `{t:'pong'}` | 25 秒心跳 |

编码：带类型标记的 JSON，覆盖结构化克隆里上游实际会用到的类型——`Buffer/Uint8Array/ArrayBuffer`（base64）、`Date`、`Map`、`Set`、
`undefined`（对象属性里丢弃、数组里保留为 `undefined`）、`BigInt`、`NaN/Infinity`、`Error`。
`webContents.send` 的参数先做上游同款 JSON 往返再编码，保证与桌面版语义一致。
invoke 的 `event` 参数：`{ sender: 主窗口.webContents, senderFrame: null, reply() }`。

单条消息上限默认 64 MB（大响应体已是 base64 文本）；超过时返回明确错误。

### 4.5 会话：单活动页面、断线重放、接管重置

- 同一实例同一时刻只有一个**活动页面**。新页面连上时，如果已有活动页面：旧页面收到 `taken-over`，显示遮罩「已在其他标签页打开」+「在这里继续」按钮。
- **断线重放**：页面短暂断线（默认 60 秒内）带同一个 `sid` 和 `last` 重连 → 服务端从环形缓冲区（默认 1 万条或 32 MB）补发 `seq > last` 的事件，
  正在进行的 invoke 结果也在缓冲区里补发。超出窗口或缓冲溢出 → 视为新页面。
- **新页面（刷新 / 接管 / 超时重连）= 桌面版重启窗口**：服务端先做「窗口级重置」——关闭全部集合、工作区、API Spec 的 watcher，
  卸载 mount、取消挂起的 OAuth2 授权、结束挂起的反向 RPC、关闭由该页面打开的终端；然后触发假窗口的 `did-finish-load`，
  等页面发来 `renderer:ready` 时由上游逻辑重新打开上次的工作区与集合。这样不需要理解上游各模块的内部状态。
  进程级状态（偏好、Cookie、OAuth2 token、全局环境、Mock Server）不重置，与桌面版重开窗口一致。
- **无活动页面时**的 `webContents.send`：写入缓冲区（供重连补发），没人重连就随窗口重置一起丢弃。
- 反向 RPC（如文件对话框）只发给当前活动页面；页面断开时以「取消」结果结束，避免主进程永久挂起。

### 4.6 文件：对话框、上传、下载

- **根目录**：`BRUNO_WEB_ROOTS`（默认 `/data/workspace`），文件对话框只能浏览这些根目录内的路径（`realpath` 后校验，防 `..` 和符号链接跳出）。
- **打开对话框**（`showOpenDialog`）：支持 `openFile / openDirectory / multiSelections / createDirectory / filters / defaultPath`。
  对话框里额外提供「从本机上传」：选本地文件 → 上传到当前浏览目录 → 选中。导入集合 ZIP、证书、Proto 文件等都能走通。
- **保存对话框**（`showSaveDialog`）：两个选项——「保存到服务器」（选目录 + 文件名）或「下载到本机」。
  选后者时返回 `$DATA/tmp/downloads/<随机 id>/<文件名>`，等触发这个对话框的 invoke 结束、文件已写入后，服务端向页面推送下载链接（一次性 token，10 分钟过期），页面自动下载，下载后删除临时文件。
- **`getFilePath(file)`**（同步）：bridge 立即生成 `uploads/<uuid>/<文件名>` 的服务端绝对路径并返回（路径前缀由服务端在页面启动时下发），
  同时后台上传该 File；之后每次 `invoke` 发送前，先等待所有未完成的上传（失败则 invoke 以明确错误失败）。上传目录 24 小时清理。
- **集合位置的默认值**：首次启动把偏好里的 `defaultLocation` 设为第一个根目录（上游 `resolveDefaultLocation` 用 `documents`，垫片已指到数据目录）。

**边界说明**：文件根目录限制只约束**对话框**。上游的 IPC 处理函数本身接受前端传来的任意路径（如 `renderer:open-collection`），
一期不在 256 个通道上逐个做路径校验（无法做全，做一半反而给人虚假的安全感）。真正的边界是**容器**：进程以非 root 用户运行、
只挂载 `/data`，能访问的就只有这个用户自己的数据。这一点写进部署文档。

### 4.7 OAuth2

上游有两条路径，网页版都保留 `state` 校验（上游逻辑不动）：

1. **内嵌窗口**（`authorizeUserInWindow`，`new BrowserWindow` + 监听跳转）：垫片里的「OAuth 假窗口」在 `loadURL(authorizeUrl)` 时向页面发反向 RPC：
   页面 `window.open(authorizeUrl)` 打开弹窗，同时显示面板「请在弹窗中完成登录」，面板上有输入框「若停在回调页面，粘贴地址栏里的完整地址」。
   回跳地址到达的途径有两个：
   - 回调地址配置成本服务的 `https://<本服务>/bruno-web/oauth2/callback`（面板上提示并可一键复制）→ 后端收到后转给假窗口；
   - 用户粘贴回跳地址。
   假窗口收到地址后依次触发 `did-navigate` / `will-redirect`，上游的 `matchesCallbackUrl` 照常匹配并 `close()`。用户关掉面板 → 触发 `close`，上游按「窗口已关闭」拒绝。
   内嵌窗口独有的「记录授权过程中每个请求的调试信息」（`webRequest` 钩子）网页版拿不到，调试面板里只会有起止两条。
2. **系统浏览器**（`authorizeUserInSystemBrowser` + `bruno://app/oauth2/callback`）：`shell.openExternal` 走弹窗；
   `/bruno-web/oauth2/callback` 同时也转给 `handleOauth2ProtocolUrl`，所以把回调地址配到本服务即可自动完成。

### 4.8 Apps 文档与 `<webview>`

- 垫片截获 `appSession.protocol.handle('bruno-app', fn)`；HTTP 路由 `/bruno-web/app-doc/:token/*` 构造 `Request` 调用该 handler，原样返回内容，
  并加 CSP `sandbox allow-scripts`（文档运行在不透明源，拿不到本服务的 Cookie）。
- 前端注入 `customElements.define('webview', ...)`：内部是 `<iframe sandbox="allow-scripts">`；`src` 是 `bruno-app://…` 时改写到上面的路由，
  是 `data:` 时直接用（浏览器对 `data:` iframe 一律视为不透明源）。
  - `executeJavaScript(code)` → 向 iframe `postMessage({type:'exec', code})`，由注入到文档头部的引导脚本执行并回传结果（Promise）。
  - 引导脚本把 `console.*` 转发为父页面的 `console-message` 事件（上游 guest→host 通道正是 `console.log(SENTINEL + json)`），文档加载完成时发 `dom-ready`。
  - 引导脚本只在 Apps 文档（服务端路由返回时注入）和 `data:` 预览（改写为带引导脚本的 `srcdoc`）中存在。
- HTML 响应预览（`HtmlPreview`）只用到 `src` 和样式，自定义元素即可覆盖。

### 4.9 安全

| 面 | 措施 |
| --- | --- |
| 认证 | 三种模式：`password`（默认，`BRUNO_WEB_PASSWORD` 或其 scrypt 哈希；登录后发 HttpOnly、SameSite=Strict、HTTPS 下 Secure 的会话 Cookie，12 小时滑动过期；登录失败按来源 IP 限速）、`proxy`（信任反向代理传来的用户头，要求同时匹配共享密钥头或来源 IP 白名单）、`none`（仅允许监听 127.0.0.1 时启用，否则拒绝启动） |
| WebSocket | 升级时校验会话 Cookie + `Origin` 必须与 Host 同源（防跨站 WebSocket 劫持）；会话失效时服务端主动断开，页面显示「请重新登录」 |
| 静态与 API | 除登录页和 `healthz` 外全部要求登录；下载用一次性 token；上传限大小（默认 200 MB） |
| 脚本 | 默认 `BRUNO_WEB_ALLOW_DEVELOPER_MODE=false`：服务端拦截 `@usebruno/js` 各运行时的构造，`runtime === 'nodevm'` 时改为 `quickjs`，并向页面推送一次性提示「该实例已禁用开发者模式，脚本以安全模式运行」。不信任前端传来的配置 |
| 终端 | `BRUNO_WEB_ENABLE_TERMINAL=false` 时 `terminal:*` 通道直接返回错误，页面终端面板显示「已禁用」 |
| 密钥落盘 | `safeStorage` 垫片 AES-256-GCM，主密钥独立存放（可由 K8s Secret 注入），不与数据卷同备份即可降低泄露面 |
| 出站请求 | 请求从服务器发出，`localhost` 指服务器自身——这是功能而非缺陷，但意味着能访问服务器所在网段。部署时用网络策略约束出站范围（K8s NetworkPolicy / 防火墙），并默认屏蔽云元数据地址段 `169.254.169.254`（在 `http.Agent` 层校验目标地址） |
| 进程 | 容器内非 root（uid 1000），只读根文件系统，只挂载 `/data` |
| 前端页面 | 为 index.html 设置 CSP（`frame-src 'self' data:`、`connect-src 'self'` 等，按上游实际需要的外部资源放行），`X-Frame-Options: DENY` |

## 5. 前端设计

- **不改上游前端源码**。服务端在返回 `index.html` 时插入（必须在应用包之前、同步执行）：
  `<script src="/bruno-web/bridge.js">` 与 `<link href="/bruno-web/bridge.css">`，并内联启动配置（上传路径前缀、实例名、功能开关）。
- `window.ipcRenderer`：`invoke / send / on（返回取消函数）/ removeAllListeners / getFilePath / openExternal`，与 preload 同签名；
  `on` 的处理函数只收到参数（上游 preload 也去掉了 `event`）。
- 连接状态遮罩：首次连接中、断线重连中（不遮挡，顶部细条）、已被其他页面接管、登录过期。
- 文件对话框、OAuth 面板、下载提示用 Shadow DOM 渲染，配色读取 Bruno 当前主题（页面根节点 class），不干扰上游样式。
- CSS 隐藏 Windows/Linux 标题栏上的最小化/最大化/关闭按钮（`AppTitleBar` 在这两个平台会画它们）。
- `window.isPlaywright` 置 false。

## 6. 与桌面版的差异（给用户看的）

| 场景 | 桌面版 | 网页版 |
| --- | --- | --- |
| 请求从哪发 | 你的电脑 | 服务器（`localhost` 是服务器自己） |
| 集合存在哪 | 本机文件夹 | 服务器上的工作区目录；本机文件可上传，导出可下载 |
| 选文件夹/文件 | 系统对话框 | 网页里的服务器文件浏览器 |
| OAuth2 登录 | 内嵌窗口自动拿回调 | 弹窗登录；回调地址配成本服务可自动完成，否则粘贴回跳地址 |
| 脚本开发者模式 | 可用 | 默认禁用（管理员可开） |
| 内置终端 | 可用 | 默认禁用（管理员可开，开了就是服务器 shell） |
| 多窗口 | — | 同一时刻一个标签页 |

## 7. 上游维护

- 固定基线 `UPSTREAM_COMMIT`；目标是**零补丁**。若确需改上游，补丁放 `patches/`，构建时 `git apply`，并在本节列出被改的文件（当前：无）。
- 升级步骤：改 `UPSTREAM_COMMIT` → `scripts/fetch-upstream.sh` → 看 selfcheck 的「缺失通道」「未实现 Electron API」两张清单 → 跑端到端测试。

## 8. 部署

- 镜像：多阶段构建，`node:22-bookworm-slim` 运行时；构建阶段跑上游 `setup`（跳过 Electron 与 Playwright 浏览器下载）和 `build:web`。
- 运行参数（环境变量）：`PORT`、`BRUNO_WEB_DATA`（默认 `/data`）、`BRUNO_WEB_ROOTS`、`BRUNO_WEB_AUTH`、`BRUNO_WEB_PASSWORD`、
  `BRUNO_WEB_SECRET_KEY`、`BRUNO_WEB_ALLOW_DEVELOPER_MODE`、`BRUNO_WEB_ENABLE_TERMINAL`、`BRUNO_WEB_TRUST_PROXY`。
- 卷：`/data`（`userData/` 偏好与 Cookie 等、`workspace/` 集合、`tmp/` 上传下载）。
- 自检 `/bruno-web/selfcheck`（需登录或本机访问）：数据目录可写、SQLite 可读写、QuickJS 能执行一段脚本、通道比对无缺失、
  未实现 Electron API 清单、对一个本地回环端点真实发一次请求并校验响应。返回非 200 即部署失败。
- 一期只在本机开发环境运行；上任何共享环境前另行征求同意。

## 9. 测试与验收

**单元测试**：编码往返（各类型）、错误消息格式、事件序号与重放、接管重置、对话框路径越界拒绝、上传等待、`electron-store` 替身读写、`safeStorage` 加解密。

**端到端（Playwright 驱动真实浏览器 + 真实服务进程）**，每条都是能当场证伪的行为：
1. 未登录访问 `/` 跳登录页；WS 不带 Cookie / 跨源 Origin 被拒。
2. 登录 → 新建集合（服务端文件对话框选目录）→ 磁盘上出现 `bruno.json`。
3. 新建请求指向本地测试服务 → 发送 → 响应面板显示正确状态码和 JSON。
4. 环境变量 + 前置脚本（安全模式）设置请求头 + 测试断言 → 测试结果面板全部通过。
5. 在磁盘上直接改 `.bru` 文件 → 页面中的请求自动更新。
6. 刷新页面 → 上次打开的集合和请求树恢复。
7. 断开 WS 5 秒再恢复 → 期间磁盘改动在页面上补齐，不需要刷新。
8. 第二个标签页打开 → 第一个显示「已在其他标签页打开」。
9. 导入：从本机上传一个 Postman/Bruno 集合文件 → 导入成功；导出：下载到本机得到文件。
10. HTML 响应预览在 iframe 里渲染。
11. OAuth2 授权码流程：用本地模拟授权服务，回调配本服务，自动拿到 token。
12. 集合设为开发者模式 + 脚本 `require('fs')` → 被降级为安全模式并提示。
13. 运行器跑整个集合 → 结果与逐个发送一致。

**完成定义**：以上 13 条全部通过；selfcheck 两张清单为空（或清单中每一项都有书面说明）；Docker 镜像本地构建并以非 root 运行通过同一套端到端测试。

## 10. 风险

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 上游某处在模块加载时就调用了垫片未覆盖的 Electron API | 启动失败 | `Proxy` 记录 + 启动即报错指明属性名；随上游升级跑 selfcheck |
| 上游前端在某处直接依赖 Electron 环境（如 `File.path`、`<webview>` 的未模拟方法） | 局部功能失效 | 端到端覆盖主要流程；未实现方法同样用 `Proxy` 告警 |
| 单活动页面限制影响习惯开多个标签页的人 | 体验 | 明确遮罩提示；二期可评估「只读旁观」 |
| 大集合首次加载时事件量大，WS 背压 | 卡顿 | 服务端按 `bufferedAmount` 节流，事件批量打包 |
| 服务器出站访问面 | 内网可达 | §4.9 网络策略 + 元数据地址屏蔽；按用户隔离容器 |

## 11. GPT 审查结论与方案修订（2026-10-25，gpt-6.1-sol / xhigh）

审查全文 21 条，逐条对照上游源码核实后的处理如下。正文与本节冲突时以本节为准。

| # | 问题 | 核实 | 处理 |
| --- | --- | --- | --- |
| 1 | `renderer:install-postman-packages` 会跑 `npm install`，依赖的生命周期脚本可在服务器上执行代码 | 属实（`ipc/collection.js:2549`、`utils/install-packages.js:115`） | 与开发者模式同属「在服务器上执行代码」，未开启开发者模式时该通道直接拒绝 |
| 2 | 安全模式脚本 `bru.getProcessEnv()` 能读到整个 `process.env`，含本服务密码与主密钥 | 属实（`store/process-env.js:20` 每次实时读取） | 配置读入后立刻从 `process.env` 删除全部 `BRUNO_WEB_*`；部署文档要求不要把平台凭据放进容器环境变量。§4.6 的边界表述改为：根目录只限制文件对话框，进程能读该 uid 可读的一切文件，隔离靠容器 |
| 3 | 自定义元素名必须带连字符，`customElements.define('webview')` 会抛错 | 属实 | 改为包装 `document.createElement`：创建 `webview` 元素时就地装上 `executeJavaScript` 等方法，并在其内部放一个沙箱 iframe；属性变化用 MutationObserver 跟踪 |
| 4 | 前端路径模块按浏览器系统选 `win32/posix`，Windows 浏览器连 Linux 服务器会拼出反斜杠路径 | 属实（`utils/common/path.js:44`） | 服务器非 Windows 时，bridge 把 Windows 浏览器的 `navigator.userAgent/platform` 改报为 Linux（`platform` 库据此判断）；快捷键在两者上都是 Ctrl，不受影响。Windows 服务器 + 非 Windows 浏览器不支持（容器部署不会出现） |
| 5 | 垫片缺 `fromWebContents/getAllWindows/isDestroyed/addRecentDocument`、`process.resourcesPath` | 属实 | 实现中已补齐；加载验证（219 个处理函数注册、未实现 API 为 0）已通过 |
| 6 | 超时重连/缓冲溢出/接管后页面里的 React 状态仍在，不能当新页面 | 属实 | 无法连续重放时页面**强制整页刷新**；「在这里继续」同样整页刷新 |
| 7 | 关 watcher 不是完整重置，旧页面的异步任务会影响新页面 | 部分属实 | **放弃「新页面时关闭 watcher」**：上游 mount 服务明确支持渲染进程重载（`services/mount/manager.js:76` "renderer reload — pull fresh state from cache and re-emit"），关 watcher 反而会让重载分支不再建监听。新页面按桌面版「重载窗口」处理，主进程状态保留，旧请求的迟到结果与桌面版重载时行为一致。退出时补发 `window-all-closed`（gRPC 清理挂在它上面）。不采纳「每页一个子进程」 |
| 8 | 断线时已发出但服务端未收到的 invoke 会永久挂起；简单重发会重复执行 | 属实 | 服务端按页面记账（id → 已收到/已完成），每条结果带序号；重连成功后页面提交未决 id 清单，服务端回复哪些从未收到，页面只重发这些；服务端对重复 id 去重。`send` 同样带 id 记账 |
| 9 | 回调页需要登录才能进；隐式授权 token 在 `#` 后不会发给服务器 | 属实 | 回调地址 GET 只返回静态页面（免登录），页面读取完整地址（含 `#`）后用同源 POST 提交，POST 需要登录 Cookie（同源 fetch 会带 SameSite=Strict Cookie）。上游 `state` 校验不变 |
| 10 | 上传文件 24 小时清理会让写进集合配置的证书/OpenAPI 路径失效 | 属实 | 上传文件改为长期保存在 `$DATA/uploads`，不自动清理 |
| 11 | 只读根文件系统下 `os.tmpdir()` 不可写 | 属实 | 启动时 `TMPDIR` 指向数据目录（已实现） |
| 12 | 页面一接入就触发 `did-finish-load`，React 监听还没挂，`main:app-loaded` 会丢；每次重载都从磁盘重灌 Cookie | 属实 | 页面在 `load` 事件后才通知服务端触发 `did-finish-load`；bridge 对「到达时还没有监听者」的早期事件暂存，等首个监听者注册时补发（只在页面启动后 10 秒内）。Cookie 只在首次初始化，之后只推送列表 |
| 13 | 每个上传文件一个目录，proto `import`、WSDL 相邻 XSD 找不到 | 属实 | 同一次选择的多个文件放进同一目录；需要互相引用的文件建议在文件对话框里「从本机上传」到集合目录。整目录上传不在一期 |
| 14 | Postman 导出、环境导出走「选目录 + 另一个写文件 IPC」，不会触发下载 | 属实（`ExportToPostman/index.js:58`、`ipc/collection.js:1021/2640`） | 对 `renderer:export-collection-postman`、`renderer:export-environment` 加导出钩子：处理完成后把新写入的文件作为下载推给页面（服务器上的副本保留）；ZIP、工作区导出走保存对话框的「下载到本机」 |
| 15 | Apps 放进不透明源 iframe 后失去 localStorage 等存储 | 属实 | 一期接受此差异并写入差异表；postMessage 校验 `event.source` 是本 iframe |
| 16 | OAuth 弹窗无法注入自定义授权头、按偏好忽略证书错误、按 session 隔离登录 | 属实 | 写入差异表 |
| 17 | 元数据地址屏蔽不覆盖代理等路径 | 属实 | 改称「尽力而为」：在 `dns.lookup` 与 `net.Socket.connect` 两处拦截（覆盖 axios、原生 fetch、gRPC 直连），经代理的请求无法拦截；真正的边界是网络策略 |
| 18 | WS 同源校验依赖 Host，`none` 模式可能受 DNS 重绑定影响 | 部分属实 | 设置了 `BRUNO_WEB_PUBLIC_URL` 时 Origin 必须与之完全相等；`none` 模式额外要求 Host 是回环地址名 |
| 19 | 推送应复用上游的 `safeStringifyJSON/safeParseJSON`（循环引用变 `"[Circular]"`）；invoke 中对象的 `undefined` 属性应保留 | 属实 | 已改 |
| 20 | 通道统计漏了包装函数（`callIpc`），`on` 不应与 `ipcMain` 比对 | 属实 | 提取脚本加入 `callIpc`；自检只比对 invoke→handle、send→on |
| 21 | 13 条验收不足以证明「完整可用」 | 属实 | 验收扩充为功能矩阵（见 §9 补充） |

### 9 补充：验收矩阵

端到端（Playwright + 真实服务进程 + 本地测试服务）新增：GraphQL、WebSocket、SSE 流式响应、请求取消、YAML 格式集合、全局环境、集合运行器、Cookie 写入与查看、Mock Server 启动并被请求、OpenAPI 文件导入、Postman 导出下载、ZIP 导出下载、断线期间发起的请求在恢复后完成且只执行一次、缓冲溢出后整页刷新、开发者模式下 `bru.getProcessEnv('BRUNO_WEB_PASSWORD')` 读不到。
gRPC、Git 远程、AI 助手、客户端证书需要外部依赖，一期只做冒烟（通道可达、无未实现 API），不做完整流程。

## 12. 实现与验证（2026-10-25）

### 12.1 与方案的偏差

| 方案原文 | 实际实现 | 原因 |
| --- | --- | --- |
| §4.2 整包替换 `electron-store` | 不替换，只替换 `electron` | `electron-store` 只用到 `app.getPath/getVersion` 和 `ipcMain`，垫片已覆盖 |
| §4.5 新页面接入时关闭全部 watcher | 按桌面版「重载窗口」处理，不关 watcher | 见 §11 第 7 条；上游 mount 服务支持重载 |
| §4.8 `customElements.define('webview')` | 包装 `document.createElement` 就地给 `webview` 元素装方法 | 自定义元素名必须带连字符 |
| §4.9 只拦脚本运行时 | 另拦 `renderer:install-postman-packages` | npm 生命周期脚本同样在服务器上执行代码 |
| — | `main:force-quit` 改为刷新页面；主窗口 `close()` 触发上游的「未保存修改」流程；关闭标签页时有未保存请求则由浏览器询问 | 上游这里会 `process.exit()`，网页版不能让页面上的按钮停掉服务 |
| — | 加载 QuickJS 沙箱模块的那一刻临时声明 `process.versions.electron` | bruno-js 据此区分「应用」与「命令行」，命令行模式会吞掉引擎崩溃诊断；全局声明会改变 `commander`、`open` 的行为 |
| — | 页面里的 `<webview>` 向服务端登记，`webContents.getAllWebContents()` 可列出并在其中执行脚本 | 上游 Apps 测试以此驱动内嵌页；也让主进程对内嵌页的操作与桌面版一致 |

### 12.2 代码审查（GPT，xhigh，服务端与浏览器端各一轮）

两轮共 34 条，逐条复现或对照代码核实后：33 条成立并已修复，1 条不修（浏览器端第 7 条：按事件循环划分上传批次不能覆盖「逐个异步取路径」的多文件导入——该场景依赖子目录结构，浏览器本来就做不到，见差异表）。修复要点：畸形 Cookie 导致进程退出、格式错误的密码哈希可被任意密码通过、登录 shell 环境把已清除的 `BRUNO_WEB_*` 重新导入、接管后旧页面的结果被新页面同编号请求接走、重连握手前发出的新消息导致旧消息被去重丢弃、覆盖上传失败丢原文件、悬空符号链接绕出根目录、发送积压无上限等。每条修复都补了单元测试或端到端测试。

### 12.3 测试结果

| 测试 | 结果 |
| --- | --- |
| 单元测试（编码、会话层投递语义、路径约束、认证、生成页面的脚本语法） | 38/38 |
| 网页版专属端到端（文件对话框、刷新与断线恢复、接管、50 MB 响应、HTML 预览、导入导出下载、OAuth2 授权码与隐式、登录与 WebSocket 拒绝、安全默认值） | 12/12 |
| 上游 Bruno 整套端到端测试（原样运行，`scripts/upstream-e2e.sh`） | 见下 |
| Docker 镜像（构建、uid 1000 运行、登录后自检 8 项、未登录 401、免登录对外监听拒绝启动） | 通过 |

上游整套测试的未通过项，按原因：

| 测试 | 原因 | 处理 |
| --- | --- | --- |
| `apps/apps-secure-context`（3） | 断言文档协议为 Electron 专有的 `bruno-app:`、两个 App 的 origin 不同；网页版是 http(s) 与不透明源 `null` | 已知差异。实质检查（安全上下文、`crypto.subtle`、App 之间互相隔离、敏感权限被拒）单独验证通过；剪贴板写权限在 iframe 中查询为 `prompt` 而非 `granted` |
| `import/wsdl` 多文件 | 依赖放在子目录，浏览器文件选择只交出所选文件 | 已知差异，写入 README |
| `proxy/pac` | 本机 18888 端口被系统已有服务占用 | 环境冲突，与网页版无关 |
