# 重启并续跑（@local/reboot-resume）

给 DSH 增加一个可由模型调用的 `system_reboot` 工具：模型先征得用户同意，把「重启后要继续做什么」持久化成一个计划任务，然后重启电脑；DSH 重新启动后自动把续跑消息投递回同一个会话，模型从会话历史继续未完成的任务。

适合「装驱动 / 内核 / 固件后必须重启再继续」这类任务，也可以让 AI 在长任务中请求重启。

## 工作方式

一次成功调用按以下顺序执行：

1. **审批（默认）**：通过 `ctx.approval` 弹出一次性审批，明确告知会重启整台电脑、所有程序都会中断。若 profile 显式配置 `allowUnattended: true`，则跳过这一步；当前 `web` profile 已按用户选择开启无人值守。
2. **权限预检**：用 `busctl ... CanReboot` 检查 PolicyKit 是否允许当前进程无交互重启；若命令是 `sudo`，则用 `sudo -n true` 检查。
3. **安排续跑**：调用 Host 的 `schedule` 服务创建一次性计划任务，默认目标是当前会话（可用 `target_session` 指定另一个顶层会话），内容是自动续跑提示；默认在 `rebootDelaySeconds + fallbackDelaySeconds` 秒后到期，作为兜底。
4. **写重启记录**：把计划任务 id、会话 id、当前内核 boot id 写入 `$DSH_HOME/reboot-resume/<profile>/pending.json`（权限 600，原子创建，已存在则拒绝，防止两个会话同时重启）。
5. **延迟重启**：`sh -c 'sleep N; exec "$@"'` 启动 `systemctl reboot`，并调用 `concludeTurn()` 结束当前回合，让工具结果和闭合的回合先落盘。
6. **重启后快速续跑**：DSH 启动并加载本插件时，比较当前 boot id 与记录中的 boot id。发现是新一次启动，就立即 `schedule.run` 投递续跑消息，然后删除计划任务和记录。
7. **兜底**：如果启动钩子没跑（插件被禁用、boot id 不可用、DSH 启动时计划任务已经到期等），计划任务本身会在到期后投递同一条续跑消息。启动钩子只是把等待时间从约 95 秒缩短到 DSH 启动后的几秒。

重启后自动启动 DSH 不是本插件的必需条件：即使 DSH 没有开机自启，下次手动启动时启动钩子也会根据 boot id 发现机器已经重启，并立即投递续跑。当前机器的 `dsh-web.service` 已启用，因此正常情况下 DSH 会随登录自动起来。

## 环境要求

- Linux + systemd/logind。
- 当前进程能无交互重启：`busctl call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager CanReboot` 返回 `s "yes"`。
  - 如果返回 `challenge`，可以配置 polkit 规则，或把 `rebootCommand` 改成 `['sudo', '-n', 'systemctl', 'reboot']` 并配置 NOPASSWD。
- DSH 的 `schedule` 服务可用（`dsh-base` 默认包含）。

## 安装

```bash
# 在工作区中开发后，通过 plugin_manager 安装：
# action: install_bundle
# target: /home/hong/Documents/deepseek-harness/default-workspace/reboot-resume
```

安装后，插件会把工具注册到每个**顶层 agent 的 scope**（包括安装时已存在的和之后创建的），因为标准 preset 的工具表是按 agent scope 组合的。若安装/升级发生在某个回合进行中，当前回合的模型工具表可能已经生成，工具会在**下一回合**出现。子代理不会获得这个工具。

## 模型怎么调用

工具名：`system_reboot`。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `reason` | 是 | 重启原因，会显示在审批提示和续跑消息里。 |
| `resume_prompt` | 否 | 重启后那一回合的额外指令；省略则按会话历史自动续跑。 |
| `target_session` | 否 | 要续跑的会话 id；省略则续跑**调用工具的当前会话**。用于在别的聊天里发起重启、但继续本聊天任务。 |
| `dry_run` | 否 | 只检查待处理状态和重启权限，不创建计划任务、不重启。 |

示例：

```json
{
  "reason": "安装新的 NVIDIA 驱动后需要重启才能加载内核模块",
  "resume_prompt": "重启后先运行 nvidia-smi 确认驱动版本，然后继续之前的训练脚本。"
}
```

### 续跑的是哪个会话

默认目标是**调用工具的会话**：在 A 会话调用，就继续 A；B 会话不会自动继续。如果任务在 B、而你从 A 发起重启，要显式传 B 的会话 id：

```json
{
  "reason": "安装驱动后重启，继续 B 会话里的训练任务",
  "target_session": "session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

目标必须是已存在、未归档的**顶层会话**；子代理会话会被拒绝。工具结果里的 `targetSessionId` 会写明实际目标；重启后消息也只会出现在那个会话。找到目标会话 id 的办法：在目标会话里让 agent 执行 `echo $DSH_SESSION_ID`，或从该会话的 URL/日志中复制。

工具成功后返回 `code: "reboot_scheduled"`，并结束当前回合；机器会在几秒后重启。重启后模型收到的消息大致是：

```text
[Automatic continuation after reboot / 重启后自动续跑 <id>]
The computer was restarted through the system_reboot tool. DeepSeek Harness is running again.
Reboot reason: ...
Continue the interrupted task from the conversation history. First verify that the reboot actually happened ...
```

## 配置

`cordis.patch.yml` 中的字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `rebootCommand` | `['systemctl', 'reboot']` | argv 数组，不经过 shell 拼接。可用 `['sudo', '-n', 'systemctl', 'reboot']`。 |
| `rebootDelaySeconds` | `5` | 重启前的缓冲时间，范围 2–120 秒。 |
| `fallbackDelaySeconds` | `90` | 兜底计划任务的延迟，范围 30–3600 秒。 |
| `pendingDir` | `$DSH_HOME/reboot-resume/<profile>` | 状态目录；测试时可指到工作区。 |
| `staleAfterSeconds` | `604800`（7 天） | 同一 boot 下超过这个时间的未执行记录会被清理，避免永久阻塞。 |
| `allowUnattended` | `false` | 为 `true` 时跳过审批，直接按模型请求重启。当前 `web` profile 设为 `true`。 |

修改配置需要在 profile 中更新 row config 并让插件重新加载。

## 取消与恢复

- **审批阶段（未开启 allowUnattended 时）**：直接拒绝即可，不会创建计划任务，也不会重启。
- **当前 profile 开启了 allowUnattended**：调用后只有 `rebootDelaySeconds`（默认 5 秒）的窗口；要取消只能在重启前快速删除计划任务，或重启后用 `shutdown -c` 取消（具体取决于系统）。
- **已安排但还没重启**：删除对应的计划任务（计划任务页面或 `schedule_edit`），再删除 `pending.json`。如果只删记录不删任务，计划任务到期后仍会投递续跑。
- **重启后没有自动续跑**：先确认你等的是**哪个会话**（默认是调用工具的会话，不是任意旧会话）。然后检查 `pending.json`、`events.jsonl`、插件是否启用、目标会话是否被归档；也可以查看计划任务是否还在。启动钩子失败时，计划任务会在到期后兜底。
- **状态文件损坏**：插件不会删除新鲜的损坏文件，以免误删另一个重启请求；超过 7 天后会重命名为 `pending.json.corrupt-<时间戳>`。

## 安全边界

- 默认每次重启都必须通过 DSH 审批；没有审批通道时失败关闭，不重启。只有显式配置 `allowUnattended: true` 才跳过审批；当前 `web` profile 已开启，因此本 profile 的所有会话都能在无确认时重启。
- 必须先在计划任务和状态记录落盘后才启动重启命令；安排失败则不会重启。
- 同一时间只允许一个重启请求；第二个请求会得到 `reboot_already_pending`。
- 子代理不能调用（`subagent_session`），避免续跑目标落到子会话。
- 只恢复发起请求的会话，不会自动恢复其他会话；其他正在运行的会话会被重启中断。
- 会中断所有程序和未保存的工作；有审批时提示里会明确说明，无人值守模式下工具描述也会警告。

## 自测

仓库根目录的 `reboot-resume-selftest.mjs` 用真实插件代码 + 假 Schedule/审批服务 + 无害的 `rebootCommand: ['true']` 跑完整流程：

```bash
node reboot-resume-selftest.mjs
```

它覆盖：dry run、审批拒绝、成功安排、pending 拒绝、子代理拒绝、模拟 boot id 变化后的启动续跑、target_session 指向另一个会话、取消审批、无人值守跳过审批。它不会真正重启电脑。

## 文件

- `index.js`：工具、审批、权限预检、计划任务、状态文件、启动续跑、`events.jsonl` 诊断日志。
- `cordis.patch.yml`：bundle 的 Loader patch。
- `locale/en.json`、`locale/zh.json`：插件管理条目文案。
- `icon.svg`：插件图标。
