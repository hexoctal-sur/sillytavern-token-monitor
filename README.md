# SillyTavern Token Monitor

SillyTavern 扩展：统计每条消息的 token 消耗与由其它脚本触发的附加 AI 调用，并把数据随聊天文件落盘；提供可拖拽悬浮面板展示用量与费用估算。

## 功能

- **主生成统计**：每次生成（含同一楼层的重新生成/续写）记一条请求记录：输入为该轮实际发送 prompt 的 token 数（由 SillyTavern 组装完 prompt 后的 `GENERATE_AFTER_DATA` 载荷用 ST 分词器计数），输出为回复文本 token。
- **附加调用统计**：捕获同源 iframe（酒馆助手脚本）对 `/api/backends/chat-completions/generate` 的调用，按内容无关信号分类为 **剧情推进 / 填表 / 其他**，并归层到对应楼层。
- **费用估算**：基于 LiteLLM 价格库，按模型单价换算成本；剧情推进 / 填表可单独指定模型计价；**成本不持久化**，展示时现算，更新价格库后历史数据自动重估。
- **悬浮面板**：主生成与三类附加调用各自显示 calls / in / out / cost，下方是**按请求追加的流水列表**，每个请求占一个 2×3 表格块（上行：类型/楼层、出 token、模型；下行：时间、入 token、费用），同一楼层的多次生成以 `↻2`、`↻3` 标注；面板可拖拽移动、左下/右下角拖拽调大小；设置区可配置模型与分类。

## 安装

通过 SillyTavern 自带的扩展安装功能：**Extensions → Install extension**，填入本仓库的 git 地址。

或手动放入：

```
SillyTavern/data/<用户>/extensions/sillytavern-token-monitor/
```

本地开发（对所有用户）可放到 `public/scripts/extensions/third-party/`。

## 构建

扩展加载的是仓库根目录的 `index.js`（由 `src/` 打包而来）。修改 `src/` 后需重新构建：

```
npm install
npm run build     # 生成 index.js
npm run watch     # 开发时监听
```

## 使用

- 通过扩展菜单（魔杖）中的 **Token 统计** 入口或 `/tokenmonitor` 打开悬浮面板（若找不到菜单入口会退化为右下角悬浮按钮）。
- 设置区可配置：
  - **主生成模型**：留空则尝试自动读取当前 Chat Completion 模型；读不到则不计算主生成成本。
  - **剧情推进模型 / 填表模型**：用于给剧情推进、填表（及未归类的其他）调用计价。留空则用拦截到的真实模型名。
  - **汇率**：`1` 时按美元直显（`$`），否则按 `¥` 展示。
  - **分类模式**：`自动`（窗口信号 + 标记）或 `仅标记`。
  - **剧情 / 填表标记**：逗号或换行分隔，命中请求文本时强制归类（存于浏览器 localStorage）。
  - **更新价格库**：手动从 LiteLLM 官方/镜像拉取，校验后缓存到 IndexedDB。

### 模型选择

三个模型字段都是「带输入的下拉列表」：输入模型名的一部分，下拉列表实时列出价格库中所有包含该片段的模型，可直接点击选择，也支持上下键 + 回车。价格库有上万条模型，纯下拉列表无法使用；而渠道自定义的模型名往往与价格库命名不一致，手动输入会让成本估算算错，因此不允许自由输入——只能从价格库中选择。

自定义模型仅作为**回退**：先用拦截到的真实模型名匹配价格库，匹配不到时才用所选模型的单价计价，并在该行标注「按 xxx 计价」；两者都取不到则显示 `—`（带 `*` 表示部分未知）。

## 数据存放

- **请求流水**（按请求追加，一条 AI 请求一条记录）：`chat_metadata.token_monitor_requests`，含类型（主生成 / 剧情推进 / 填表 / 其他）、归层楼层、模型、输入/输出 token；面板列表与各项汇总均由此现算。
- 每条消息的快照写入该消息对象的 `extra.token_monitor`（当前楼层的输入/输出与附加调用聚合），随聊天 JSONL 落盘。
- 每个聊天的汇总写入 `chat_metadata.token_monitor`；无法归层的附加调用写入 `chat_metadata.token_monitor_unattributed`。
- 配置写入 `extensionSettings.token_monitor`（服务器 `settings.json`）；价格库缓存于浏览器 IndexedDB `token_monitor_pricing`。

## 分类信号（内容无关）

优先级从高到低：`用户自定义标记` → `填表窗口`（`GENERATION_ENDED` / `AutoCardUpdaterAPI.registerTableFillStartCallback`）→ `剧情窗口`（`GENERATION_AFTER_COMMANDS` 开启、`GENERATION_STARTED` 关闭）→ `响应回归校验`（响应文本 ↔ 楼层 `qrf_plot` / `qrf_plot_tasks`）→ 兜底 `其他`。

## 已知限制

- 输入 token 由扩展用 ST 分词器对实际请求内容计数，不与服务商官方用量对账（差值来自服务端分词/特殊标记）；附加调用若响应恰带 usage 则优先采用。
- SillyTavern 的 `generate_interceptor` 传入的 `contextSize` 是**可用 prompt 预算上限**（上下文窗口 − 回复长度），并非实际输入量，本扩展不使用该值。
- 安装本扩展之前的请求不会出现在流水中；对应消息的输入缺失时以 `—` 显示。
- 归层依赖 `qrf_plot` / 楼层文本等信号，极端情况下可能落到"未归属"（楼层列显示 `—`）。
- 仅支持自定义 API（Chat Completion）模式下经由该端点的附加调用；`generateRaw` / 主 API 的附加调用不在范围内。

## 许可

[CC BY-NC-SA 4.0](LICENSE) — 署名（BY）、非商业（NC）、相同方式共享（SA）。

- **署名**：转载或修改本项目时须注明原作者。
- **非商业**：仅允许非商业用途。
- **允许修改**：允许基于本项目进行修改。
- **相同方式共享**：若发布修改版，须以相同协议发布。
