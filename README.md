# SillyTavern Token Monitor

SillyTavern 扩展：统计每条消息的 token 消耗与由其它脚本触发的附加 AI 调用，并把数据随聊天文件落盘；提供可拖拽悬浮面板展示用量与费用估算。

## 功能

- **主生成统计**：每条消息记录输入（本轮 prompt 上下文 token）与输出（回复文本 token），分项累计。
- **附加调用统计**：捕获同源 iframe（酒馆助手脚本）对 `/api/backends/chat-completions/generate` 的调用，按内容无关信号分类为 **剧情推进 / 填表 / 其他**，并归层到对应楼层。
- **费用估算**：基于 LiteLLM 价格库，按模型单价换算成本；**成本不持久化**，展示时现算，更新价格库后历史数据自动重估。
- **悬浮面板**：主生成与三类附加调用各自显示 calls / in / out / cost，附楼层明细表（含 P/F/O 徽标）与设置区。

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
  - **汇率**：`1` 时按美元直显（`$`），否则按 `¥` 展示。
  - **分类模式**：`自动`（窗口信号 + 标记）或 `仅标记`。
  - **剧情 / 填表标记**：逗号或换行分隔，命中请求文本时强制归类（存于浏览器 localStorage）。
  - **更新价格库**：手动从 LiteLLM 官方/镜像拉取，校验后缓存到 IndexedDB。

## 数据存放

- 每条消息的统计写入该消息对象的 `extra.token_monitor`，随聊天 JSONL 落盘。
- 每个聊天的汇总写入 `chat_metadata.token_monitor`；无法归层的附加调用写入 `chat_metadata.token_monitor_unattributed`。
- 配置写入 `extensionSettings.token_monitor`（服务器 `settings.json`）；价格库缓存于浏览器 IndexedDB `token_monitor_pricing`。

## 分类信号（内容无关）

优先级从高到低：`用户自定义标记` → `填表窗口`（`GENERATION_ENDED` / `AutoCardUpdaterAPI.registerTableFillStartCallback`）→ `剧情窗口`（`GENERATION_AFTER_COMMANDS` 开启、`GENERATION_STARTED` 关闭）→ `响应回归校验`（响应文本 ↔ 楼层 `qrf_plot` / `qrf_plot_tasks`）→ 兜底 `其他`。

## 已知限制

- 剧情推进/填表路径不回传 usage，token 由扩展自行计数（若响应恰带 usage 则优先采用），不与服务商官方用量对账。
- 历史 AI 消息的输入 prompt token 无法精确还原，缺失时以 `—` 显示。
- 归层依赖 `qrf_plot` / 楼层文本等信号，极端情况下可能落到"未归属"。
- 仅支持自定义 API（Chat Completion）模式下经由该端点的附加调用；`generateRaw` / 主 API 的附加调用不在范围内。

## 许可

AGPL-3.0
