# DSH Burp MCP 中文使用手册

**这是什么：**它把 Burp 的官方 MCP 工具接入 DeepSeek Harness（DSH），让 AI 默认通过 Burp Proxy 发送 HTTP 请求，同时保留显式选择 Burp 扩展 HTTP API 的方式，方便你在 Burp 中查看和接管流量。

本文面向 **1.3.2 公开版**，仓库：[loud404/dsh-burp-mcp](https://github.com/loud404/dsh-burp-mcp)。
已验证的 DSH 版本为 **0.2.2-rc.5**；其他版本请先核对仓库的兼容说明。

## 1. 先分清：MCP 是控制，Proxy 是流量

MCP 负责“让 DSH 调用哪个工具、传入什么参数、取回什么结果”；Proxy 负责“HTTP 流量经过哪里”。
因此，这里不是在 MCP 和 Proxy 之间二选一，而是同一组 MCP 发送工具提供两条路径：

```text
默认 proxy：
AI → DSH MCP → 本插件的 MCP 网关 → Burp Proxy（通常 8080）→ 目标站点

可选 extension：
AI → DSH MCP → 本插件的 MCP 网关 → Burp 官方 MCP（通常 9876/mcp）
   → Burp 扩展 HTTP API → 目标站点
```

两条路径都使用 `mcp__burp__send_http1_request` 或 `mcp__burp__send_http2_request`：

| 选择 | 参数 | 在 Burp 哪里看 | 主要等待位置 |
|---|---|---|---|
| 默认 Proxy | 省略 `route`，或填 `"proxy"` | **Proxy → HTTP history** | Proxy Intercept 及相关过滤规则 |
| 原扩展 API | 填 `"route": "extension"` | **Logger**，查看扩展来源的条目 | Burp MCP 的原有 HTTP 审批 |

**extension 仍然由 Burp 发请求，绝不是绕过 Burp 的直连。** 它不经过 Proxy listener，因此不应只用 Proxy history 判断它是否已发送。
两条路径都保留 DSH 侧的工具执行规则；插件不会替你批准请求，也不会自动调整 Intercept。
路径失败后不自动换路、不自动重试；其他 Burp MCP 工具继续交给 Burp 官方 MCP 处理。

## 2. 安装前准备

- **DSH**：先确认自己的版本；本文以 0.2.2-rc.5 为基准。
- **Node.js 22 或更高版本**：使用 [Node.js 官方发行的运行时](https://nodejs.org/)，并安装 npm。不要把 DSH Desktop 的 Electron 程序当作 Node。
- **Burp Suite 和官方 MCP 支持**：按 [PortSwigger 官方 MCP 项目说明](https://github.com/PortSwigger/mcp-server)安装、启用对应扩展，并启动提供 `/mcp` 的 HTTP 服务。
- **Burp Proxy listener**：推荐先使用 `http://127.0.0.1:8080`。
- **Google Chrome（可选）**：仅专用浏览器功能需要；只调用 MCP HTTP 工具时不需要安装 Chrome。本插件不要求安装 Edge。
- **Git（可选）**：用于 clone；不装 Git 也可以在仓库页面下载 ZIP。

先在 PowerShell 检查 Node 和 npm：

```powershell
node --version
npm --version
(Get-Command node).Source
```

Node 版本应至少为 22；最后一条会显示当前终端实际使用的 Node 路径。
Burp 的 **9876 是 MCP 控制端口，8080 是 Proxy 流量端口**，不要互换。
如果你在 Burp 中使用了其他端口，后面的配置也要一起改。

## 3. Windows 推荐安装流程

### 可选：直接使用市场／Release 安装包

如果 DSH 进程已能在 PATH 找到独立 Node.js 22+，可以直接在 **插件 → 添加插件**中输入固定版本安装包 URL：

```text
https://github.com/loud404/dsh-burp-mcp/releases/download/v1.3.2/dsh-burp-mcp-1.3.2.tgz
```

不需要从源码构建，也不需要安装期脚本；Burp MCP 和 Proxy 仍要先开启。正式市场收录完成后，可由市场条目进入该安装包。仓库里提供的只是安装包，不代表已经被市场收录。

若 DSH 桌面进程找不到 `node`，或你要指定可执行路径/不同端口，使用下面可编辑的本地目录安装流程。不要在包管理器的缓存目录手改文件。

### 第一步：取得插件并安装依赖

在你准备长期保存插件的目录打开 PowerShell：

```powershell
git clone https://github.com/loud404/dsh-burp-mcp.git
Set-Location .\dsh-burp-mcp
npm install --ignore-scripts
node scripts/configure.mjs
(Get-Location).Path
```

不用 Git 时：在 GitHub 仓库页面选择 **Code → Download ZIP**，解压后进入包含包清单的插件根目录，再运行上述后三条安装、配置和路径查询命令。
`npm install --ignore-scripts` 安装依赖但跳过依赖安装脚本；插件使用已经装好的 Chrome，不需要下载配套浏览器。

**请先运行配置脚本，再把插件目录添加到 DSH。** 脚本会写入本次使用的 Node 真实绝对路径、找到的 Chrome 路径，并备份原配置，避免桌面启动的 DSH 找不到终端里的 `node`。
未找到 Chrome 时会提示，但仍可使用 MCP 工具。脚本不发网络请求，不改 DSH profile、系统代理或 Burp 设置，也不替你批准请求。
最后一条输出的目录就是稍后要填写的**绝对目录**；保留这份目录，不要安装后立刻移动或删除。

### 第二步：在 DSH 中添加目录并启用

1. 打开 DSH 左侧栏的**插件**页面，选择**添加插件**。
2. 在添加插件的输入位置填入上一步得到的**绝对目录路径**，而不是 GitHub 网页地址，也不是某个源文件路径。
3. 完成安装后，确认本插件的 **MCP 接入**组件处于启用状态；需要专用浏览器时，再启用相应浏览器组件。
4. 如果已有另一个以 `burp` 为服务器名的 MCP 接入，先停用重复项，只保留你准备使用的这一份。
5. 按 DSH 显示的加载结果处理；如提示需要重启，重启 DSH。配置改变后重新加载插件或重启，让 MCP 重新连接。
6. 新开一个会话，先按下一节确认工具已出现，再发送一个普通 GET 请求。

本插件通过插件目录接入，不需要另外创建同名 MCP 连接。

### 第三步：用普通请求验证

先给 AI 这段提示词；这一步只让 Burp 生成随机字符串，不访问目标站点：

```text
请检查 Burp MCP 工具是否可用，调用 mcp__burp__generate_random_string，
参数为 {"length": 8, "characterSet": "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}。
只报告连接结果，不发送目标请求。
```

然后用自己的站点，或用 `example.com` 做一次不含测试载荷的连通性检查：

```text
请只向 https://example.com/ 发送一次普通 GET 请求。
使用 mcp__burp__send_http1_request，省略 route，保持默认 proxy；
不要扫描、不要变异参数、不要自动重试或切换路径。
报告状态码、结果中的 MCP route 标记，并提示我在 Proxy → HTTP history 查看。
```

默认路径的结果应包含 `[MCP route=proxy; ...]`，并可在 Burp 的 Proxy HTTP history 中核对。
如果请求正在等待，先看 Intercept；历史列表还可能受过滤器影响。HTTP 结果不必固定为 200，重点是路径、记录与响应能对应。
确认默认路径后，才按需使用 `extension`，并在 Logger 及 Burp MCP 审批位置核对。

## 4. 可以直接照着用的调用示例

下面是传给指定工具的 JSON 参数，不是完整的 MCP 协议封包。示例均为一次普通 GET。
把域名替换为自己的站点时，同步修改 `targetHostname`、`Host` 或 `:authority`；端口和 `usesHttps` 也要匹配。

### HTTP/1：默认 Proxy

工具：`mcp__burp__send_http1_request`。省略 `route` 即为默认 `proxy`。

```json
{
  "content": "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n",
  "targetHostname": "example.com",
  "targetPort": 443,
  "usesHttps": true
}
```

### HTTP/1：显式选择 Burp 扩展 API

仍是同一个 MCP 工具，只增加 `route`；它不是 Proxy 故障时的自动后备线路。

```json
{
  "content": "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n",
  "targetHostname": "example.com",
  "targetPort": 443,
  "usesHttps": true,
  "route": "extension"
}
```

也可以直接告诉 AI：“这一次仍使用 Burp MCP，但明确选择 `route=extension`，只发一个普通 GET；不要回退到其他路径。”
结果应包含 `[MCP route=extension; ...]`；到 Logger 查看，不要等待 Proxy history 出现相同条目。

### HTTP/2：请求头与正文必须分开

工具：`mcp__burp__send_http2_request`。必须提供 `headers` 和 `pseudoHeaders` 对象；没有普通头时也要写 `"headers": {}`。
`requestBody` 只放正文；不要把 HTTP 请求头或伪头塞进正文。

```json
{
  "headers": {},
  "pseudoHeaders": {
    ":method": "GET",
    ":path": "/",
    ":scheme": "https",
    ":authority": "example.com"
  },
  "requestBody": "",
  "targetHostname": "example.com",
  "targetPort": 443,
  "usesHttps": true
}
```

这个例子省略 `route`，仍走 Proxy。需要原扩展 API 时，在同一对象中加入 `"route": "extension"`。
Proxy 路径的 HTTP/2 要求 HTTPS，并成功协商 ALPN `h2`；不支持明文 h2c，也不自动降为 HTTP/1。
这里的 HTTP/2 表示**客户端到 Burp**这一段；Burp 到站点使用什么协议由 Burp 决定。

## 5. 可选：打开专用 Chrome 窗口

专用浏览器是页面浏览辅助，工具名为 `burp_browser`，与上面的两条 MCP HTTP 发送路径分开。
它使用独立临时配置，不接管你已经打开的普通 Chrome 窗口。

```json
{"action": "open", "url": "https://example.com/"}
```

省略 `route` 时，专用窗口的 HTTP/HTTPS 和 WS/WSS 默认经过 Burp Proxy；失败后不会自动直连。
查看状态用 `{"action": "status"}`；换页用 `{"action": "navigate", "url": "https://example.com/"}`。
结束后调用：

```json
{"action": "close"}
```

只有明确需要让**这个浏览器窗口**不经过代理时，才使用：

```json
{"action": "open", "url": "https://example.com/", "route": "direct"}
```

**浏览器的 `direct` 与 MCP 的 `extension` 不是一回事。** HTTP 发送工具只接受 `proxy` 或 `extension`。
浏览器切换路径会关闭旧窗口并丢弃临时 Cookie；后续 `open`/`navigate` 再次省略 `route` 时仍默认 Proxy。
临时登录状态不会带到下次新窗口；下载和 Service Worker 被禁用，依赖这些功能的页面可能表现不同。

## 6. 修改连接、Node 或浏览器路径

在 clone 或解压得到的插件根目录运行 `node scripts/configure.mjs`。需要指定参数时，可以按实际环境组合这些选项；用 `node scripts/configure.mjs --help` 查看用法：

```powershell
node scripts/configure.mjs --node "C:\Program Files\nodejs\node.exe" --browser "C:\Program Files\Google\Chrome\Application\chrome.exe" --mcp "http://127.0.0.1:9876/mcp" --proxy "http://127.0.0.1:8080"
```

| 配置或选项 | 含义 |
|---|---|
| `--node` → `gatewayNode` | 网关使用的独立 Node 可执行文件；省略时，配置脚本写入当前 Node 的绝对路径 |
| `--browser` → `browserExecutable` | 指定已安装的 Chrome；省略时脚本尝试自动查找，找不到就保留空值，打开浏览器时再查找 |
| `--mcp` → `url` | Burp 官方 MCP 的 HTTP 地址，通常为 `http://127.0.0.1:9876/mcp` |
| `--proxy` → `proxyUrl` | Burp Proxy listener，通常为 `http://127.0.0.1:8080`，用于 HTTP 默认路径及专用浏览器 |

公开版原始配置中的 `gatewayNode` 是 `node`、`browserExecutable` 是空字符串；运行配置脚本后会写入找到的本机路径。不要复制别人的机器路径。
macOS 常见浏览器路径为 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`；Linux 会尝试 `/usr/bin/google-chrome`、`/usr/bin/chromium`、`/usr/bin/chromium-browser`，也可用 `--browser` 指定。本文的完整桌面操作以 Windows 为基准。
Proxy 地址要求 HTTP 回环监听地址；MCP 地址需要包含正确的 `/mcp` 路径。改端口时，两者仍要各填各的。
配置保存在插件根目录的 [cordis.patch.yml](<../cordis.patch.yml>)；脚本保存前会将原文件备份为同目录下的 `cordis.patch.yml.bak`，再次运行会更新该备份。
手动编辑前也请单独备份。每次运行脚本都会重写这份配置，省略的 `--mcp`、`--proxy` 会使用默认地址；自定义端口请每次明确传入，完成后重新加载插件或重启 DSH。

默认内部请求超时为 120 秒，DSH 工具调用预算为 130 秒，启动预算为 45 秒；响应字节上限默认为 2 MiB。
等待审批也会消耗超时预算。需要调整时，让工具调用预算覆盖内部请求预算；不要先通过缩短超时掩盖连接或审批问题。

## 7. 出问题时，按这个顺序排查

| 现象 | 先检查什么 |
|---|---|
| 找不到 Burp MCP 工具 | Burp 官方 MCP 已启动、插件已启用、9876 上的 `/mcp` 可连接；再检查同名 `burp` 接入冲突 |
| 提示找不到 `node` 或启动进程失败 | 运行 `node --version` 和 `(Get-Command node).Source`，在插件目录重新运行配置脚本，然后重启 DSH |
| 终端能运行 Node，桌面 DSH 却失败 | 桌面进程的 PATH 可能不同；使用配置脚本写入的 Node 绝对路径，不要只依赖新改的 PATH |
| 默认请求一直等待 | 8080 listener 正在运行吗？Proxy Intercept 中是否有待处理请求？DSH 是否也在等待工具审批？ |
| `extension` 一直等待 | 查看 Burp MCP 的原有 HTTP 审批，不要只查看 Proxy Intercept |
| 有响应，但 Proxy history 没条目 | 先读结果中的 route；extension 看 Logger，proxy 检查 HTTP history 过滤器及监听端口 |
| HTTPS 证书或 CA 获取失败 | 确认配置确实指向本机 Burp listener，Burp 能提供自身 CA，并检查 Intercept 是否卡住证书获取 |
| HTTP/2 协商失败 | 确认使用 HTTPS、客户端到 Burp 能协商 h2；不要把 h2c 地址当作可自动降级的请求 |
| 专用浏览器启动失败 | 确认已安装 Chrome；自动查找不到时，用 `--browser` 指定其可执行文件绝对路径 |
| 结果超过大小上限 | 缩小请求返回内容；确有需要再调整响应上限，而不是假定收到的是完整响应 |
| Burp 工具发生变化，DSH 仍显示旧工具 | 重新加载插件或重启 DSH，重新建立 MCP 连接 |

**超时、取消或连接中断，不证明目标没有收到请求。** 重发前先核对 Burp 和自己站点的记录，特别是会修改数据的请求。
错误结果会注明未自动切换路径；需要换路时，由你明确决定，并作为一次新的调用处理。

## 8. 使用前知道的几条边界

- **不是全系统代理。** 它不改模型 API、插件下载、`web_fetch`、Shell、其他工具或普通浏览器的流量。
- **不是原始字节重放器。** Proxy 路径把请求作为 UTF-8 HTTP 处理，会重算 `Content-Length`、处理连接字段并移除 `Transfer-Encoding`；不用于逐字节、二进制或畸形分块报文重放。
- **响应可能已解压。** 返回文本中的 `bodyDecoded` 标记说明正文是否解压；保留的原响应头可能仍写着压缩编码。
- **工具列表是连接时快照。** Burp 增减工具后需要重连；不要把旧会话里的列表当作实时自动更新。
- **TLS 信任各有边界。** Proxy HTTP 请求使用从配置的本机 Burp listener 取得的 CA 验证连接；专用浏览器使用限定于该 CA 公钥的证书例外，不是关闭所有证书校验，也不向系统全局安装 CA。
- **直连浏览器使用正常证书校验。** `extension` 的 TLS 行为由 Burp 的扩展 HTTP API 设置决定。
- **专用浏览器是临时环境。** Cookie 随窗口关闭或路径切换而丢弃；下载和 Service Worker 受限；它不是全协议网络隔离边界。
- **启动不等于发起目标请求。** MCP 启动会连接 Burp、读取工具清单，也可能做协议探测；只有调用发送工具时，才按请求参数访问目标。

## 9. 停用、卸载和升级

- **暂时停用**：先用 `burp_browser` 的 `close` 关闭专用窗口，再在 DSH 插件页停用相应组件；需要时重新启用并重连。
- **卸载**：在 DSH 插件页移除本插件，按界面结果重启或重新加载；确认已经移除后，再删除不再需要的本地插件目录。
- **升级**：先记下自定义端口和路径，备份本地配置；关闭专用窗口并停用旧插件。下载新版本到新目录，重新执行依赖安装和配置脚本，再添加新目录、启用并验证；不要同时启用两份 `burp` 接入。
- **回到旧版**：保留旧目录和版本信息，停用新版后重新添加并启用旧目录；换机器时仍应重新运行对应版本的配置脚本。

停用或卸载不会替你删除 Burp 项目、清理 Burp 的历史记录，或改动普通 Chrome 的用户数据。

## 10. 常见问题与反馈

**一定要装 Chrome 吗？** 不用。只使用 Burp MCP 工具时，Node、DSH 和 Burp 官方 MCP 服务即可；专用浏览器功能才需要 Chrome。

**我只用默认 Proxy，为什么仍要启动 Burp MCP？** 网关启动时从官方 MCP 取得工具定义，其他 Burp 工具也通过它执行，所以只开 8080 listener 不够。

**为什么看到不止一次 MCP 初始化？** DSH/SDK 可能先做协议探测，再启动实际网关；这不代表向目标重复发送了请求。

**把 `route` 写成 `direct` 能让 HTTP 工具直连吗？** HTTP 发送工具只支持 `proxy`、`extension`；`direct` 只属于独立的专用浏览器工具。

**如何报 Bug？** 到 [GitHub Issues](https://github.com/loud404/dsh-burp-mcp/issues)提供插件、DSH、Node、Burp 和操作系统版本；浏览器问题再附 Chrome 版本。
写清使用的工具、route、错误原文、预期现象、实际现象，以及最小复现步骤；可用 `example.com` 或本地自有示例复现。
先删除 Cookie、Authorization、Token、密码、查询参数、个人路径和敏感主机名；不要上传完整 Burp 项目、全量历史或未脱敏请求/响应。
截图同样要检查地址栏、请求头、正文和侧边栏；附上路由结果首行及相关错误片段通常比贴整份日志更有帮助。
