# DSH Burp MCP

**让 DeepSeek Harness 用 MCP 控制 Burp 测试，并把测试 HTTP 流量默认送入 Burp Proxy。**

需要原来的 Burp 扩展发送方式时，只加 `route=extension`。两种方式使用**同一个 MCP 工具**，不需要在“MCP”和“代理”之间二选一。

[完整中文使用手册](docs/USER_GUIDE.zh-CN.md) · [安装与配置](#快速开始) · [常见问题](#常见问题) · [开发说明](docs/DEVELOPMENT.md)

> 这是适用于 **DeepSeek Harness（DSH）** 的独立社区插件，不是 Burp 内安装的 Java 扩展。Burp 端仍需要安装并启用 [PortSwigger 官方 MCP Server 扩展](https://github.com/PortSwigger/mcp-server)。

## 它解决什么问题？

Burp 原生 MCP 的 HTTP 发送工具通过扩展 API 发请求，通常应在 **Logger** 查看。它不一定经过 **Proxy → HTTP history** 对应的代理监听器。

这个插件给原 MCP HTTP 发送工具加了一个简单选项：

| 路由 | 怎么选择 | 请求经过哪里 | 在 Burp 哪里看 |
|---|---|---|---|
| **Proxy（默认）** | 不填 `route`，或 `route=proxy` | MCP 网关 → Burp Proxy → 网站 | Proxy → HTTP history；是否显示取决于过滤器 |
| **Extension（可选）** | `route=extension` | MCP 网关 → 原 Burp MCP 扩展 HTTP API → 网站 | Logger → Extensions |

```text
AI / DSH
  └─ MCP tools/call（同一个工具）
       ├─ 默认 proxy ─────→ Burp Proxy :8080 ───→ 目标网站
       └─ 可选 extension ─→ Burp MCP :9876 ─────→ 扩展 HTTP API ─→ 目标网站
```

**Extension 仍然是 Burp 发出的请求，不是绕过 Burp 直连。失败时不会偷偷换路由。**

## 主要功能

- 保留 `mcp__burp__send_http1_request` / `mcp__burp__send_http2_request` 工具名。
- HTTP 请求默认经过 Burp Proxy，便于查看历史、拦截和修改。
- 可随时明确选择原扩展 HTTP API 路径。
- 其他 Burp MCP 工具按上游可用能力转发；数量取决于 Burp 版本和版本授权。
- 可选的独立 Chrome 测试窗口，不读取普通浏览器的 Cookie 或历史。
- 不修改系统代理，不把模型 API、插件下载或其他工具流量强制送入 Burp。

## 快速开始

### 1. 准备环境

- **DSH**：已验证版本为 `0.2.2-rc.5`；插件声明这一精确版本。
- **Node.js 22 或更新的独立运行时**，不是 DSH Desktop 的 Electron 可执行文件。
- **Burp Suite**，并安装启用支持 `/mcp` 的官方 MCP Server 扩展。
- 如果使用浏览器辅助功能，再准备本机 **Google Chrome / Chromium**。

在 Burp 中确认两个地址：

| 用途 | 默认地址 |
|---|---|
| MCP 控制接口 | `http://127.0.0.1:9876/mcp` |
| Proxy 流量监听器 | `http://127.0.0.1:8080` |

**9876 是控制端口，8080 是网页代理端口，不要填反。**

### 2. 选择安装方式

**市场／Release 安装（推荐给只想使用的人）：** 下载或使用 [v1.3.2 安装包](https://github.com/loud404/dsh-burp-mcp/releases/download/v1.3.2/dsh-burp-mcp-1.3.2.tgz)。在 DSH **插件 → 添加插件**中输入该 `.tgz` 的完整 URL。安装无需构建脚本；需要 DSH 进程能找到独立 Node.js 22+ 的 `node` 命令、Burp MCP 和 Proxy 已开启。插件市场正式收录前，也可以手工用这个 URL 安装。若桌面 DSH 找不到 Node，请使用下面的本地目录流程来固定 Node 路径。

**本地目录安装（便于指定 Node、Chrome 或端口）：**

```powershell
git clone https://github.com/loud404/dsh-burp-mcp.git
cd dsh-burp-mcp
npm install --ignore-scripts
node scripts/configure.mjs
```

没有 Git 也可以从 GitHub 的 **Code → Download ZIP** 下载、解压，然后在解压目录执行后两条命令。

配置脚本会把当前独立 Node 的绝对路径、可找到的 Chrome 路径写入本目录的 `cordis.patch.yml`，并保留 `.bak`。它不会修改 DSH profile、系统代理或 Burp 设置。

需要指定不同端口或浏览器时：

```powershell
node scripts/configure.mjs --mcp http://127.0.0.1:9876/mcp --proxy http://127.0.0.1:8080
```

更多参数及不同系统的浏览器路径见[使用手册](docs/USER_GUIDE.zh-CN.md)。

### 3. 在 DSH 添加插件

1. 打开 DSH 左侧栏 **插件**。
2. 选择 **添加插件**，输入本地插件目录的**绝对路径**。
3. 安装并启用 **Burp MCP 接入**。
4. 保持 Burp 和它的 MCP Server 开启。

如果已经配置了另一个名为 `burp` 的 MCP 连接，先停用重复连接，避免工具命名冲突。当前版本没有额外的“设置 → MCP”配置页面。

### 4. 先验证，再开始测试

在 DSH 对话中说：

```text
使用 Burp MCP 生成一个随机字符串，只检查连接，不访问任何目标。
```

连接正常后，可对你自己的站点执行一次基线请求：

```text
使用 Burp MCP 访问我的测试站点。保持默认 proxy 路径，
先只请求首页并报告状态码，再确认它出现在 Burp Proxy HTTP history。
```

## 日常怎么用？

**默认走代理：**

```text
使用 Burp MCP 测试这个站点，先检查首页基线响应。
```

**改用原扩展 API：**

```text
这次仍然使用 Burp MCP，但使用 extension 路径，保留原扩展 HTTP API 的发送方式。
```

**打开专用 Chrome：**

```text
用 Burp 专用 Chrome 打开我的测试站点。
```

MCP 发送结果首行会标出 `MCP route=proxy` 或 `MCP route=extension`。看实际工具结果，不只看助手口头说了什么。

## 常见问题

**MCP 与代理能共存吗？** 能。本插件的两个发送选项都经 MCP 控制，区别仅在测试流量从哪条通道发送。

**为什么 Proxy 历史没看到？** 先看结果中的 route。`extension` 通常在 Logger；`proxy` 再检查 Proxy 历史过滤器、监听器和 Intercept。没有历史记录本身不证明请求从未发送。

**请求一直等？** `proxy` 看 Burp Proxy Intercept；`extension` 看 Burp MCP HTTP 审批提示。两条路径的审批位置不同。

**其他所有流量也默认过代理吗？** 不会。这里只默认路由本插件的 MCP HTTP 发送工具和专用 Chrome，普通浏览器、`web_fetch`、命令行和系统流量不变。

**浏览器 `direct` 和 MCP `extension` 是一回事吗？** 不是。MCP 发送工具只有 `proxy|extension`；专用浏览器单独的 `direct` 是不使用代理的浏览器会话。

更多排错、完整 JSON 参数、HTTP/2、HTTPS 证书、升级和卸载说明，见[完整中文使用手册](docs/USER_GUIDE.zh-CN.md)。

## 已知边界

- 工具清单在连接启动时发现；上游工具变化后需要重连。
- Proxy 发送是规范化 UTF-8 HTTP，不是原始字节/二进制/畸形报文重放器。
- Proxy HTTP/2 描述的是客户端到 Burp 的协议，Burp 到源站的协议由 Burp 决定。
- 浏览器使用临时配置，关闭或切路线会丢弃临时登录态；下载与 Service Worker 被关闭。
- Proxy 模式不使用原扩展 HTTP 审批框，由 DSH 工具策略和 Proxy Intercept 控制；Extension 模式保留原扩展审批。
- 已在 Windows 上验证；macOS/Linux 有浏览器发现路径，但未宣称经过完整桌面实测。

## 开发与许可证

```powershell
npm test
npm run check
```

测试使用本地模拟 MCP 和代理，不需要真实 Burp，也不会扫描外部站点。

[开发说明](docs/DEVELOPMENT.md) · [MIT License](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md)
