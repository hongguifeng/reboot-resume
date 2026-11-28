# 重启并续跑（@local/reboot-resume）

给 DSH 增加两个可由模型调用的工具：`system_reboot`（暖重启）和 `system_cold_boot`（通过 Wi-Fi 智能插座断电冷启动）。`system_reboot` 的流程是：模型先征得用户同意，把「重启后要继续做什么」持久化成一个计划任务，然后重启电脑；DSH 重新启动后自动把续跑消息投递回同一个会话，模型从会话历史继续未完成的任务。

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
| `coldBoot` | 见下节 | 冷启动（Wi-Fi 智能插座断电）配置；`enabled: false` 时不注册 `system_cold_boot`。 |

修改配置需要在 profile 中更新 row config 并让插件重新加载。

## 冷启动（Wi-Fi 小米插座）

普通 `systemctl reboot` 是暖重启；有的硬件（典型是 PCIe / GPU 重新枚举）必须**真正断电**才能恢复。
插件为此提供第二个工具 `system_cold_boot`：通过局域网直连小米 Wi-Fi 插座，先安排续跑、再断电，
电脑上电后 DSH 启动时按 boot id 立即续跑。

### 原理与硬性顺序

冷启动是"关机 → 断电 → 放电 → 上电"四段，而不是直接切电：

1. 解析插座（本地缓存 → 小米云端设备列表）并读取继电器状态，必须是 `on`；
2. 检查恢复手段（`restore.mode`）与关机权限（polkit），任一不满足就直接拒绝；
3. 创建续跑计划任务并写 `pending.json`（`kind: "cold-boot"`）；
4. 把**断电请求**和**上电请求**交给恢复手段（跳板机 / 外部命令），失败则在本机还没关机时回滚并中止；
5. 本机执行 `haltCommand`（默认 `systemctl poweroff`），缓冲 `shutdownGraceSeconds` 秒；
6. 关机约 `powerCutDelaySeconds` 秒后，恢复手段把插座的市电切断；
7. 断电保持 `outageSeconds` 秒，让电源彻底放电（否则再次上电不一定被 BIOS 当成上电自启）；
8. 恢复手段上电 → BIOS 上电自启 → DSH 启动 → 启动钩子发现 boot id 变化 → 立即续跑；
   计划任务在 `shutdownGrace + powerCutDelay + outage + fallbackDelaySeconds` 后兜底。

**顺序不能省**：先关机再断电，避免文件系统还在写的时候硬断电；断电后要等够 `outageSeconds`，否则不算冷启动；
本机一旦关机就再也无法执行代码，所以第 4 步必须成功才会走到第 5 步。

### 获取插座 IP 和 token

插座 token 只存在于小米云端（Mi Home 里看不到明文），所以要先拿一次小米云端会话，把 `localip` + `token`
缓存到 `$DSH_HOME/reboot-resume/<profile>/plug.json`（0600，不写进 profile 配置）。

**推荐：用浏览器登录后的会话（绕开命令行登录验证码）**

```bash
cd /home/hong/Documents/deepseek-harness/default-workspace/plugin-src/reboot-resume

node tools/probe.mjs session \
  --service-token '<浏览器的 serviceToken>' \
  --ssecurity '<serviceLoginAuth2 响应里的 ssecurity>' \
  --user-id '<浏览器的 userId>'
```

三个值这样拿（Chrome / Edge / Firefox 都一样）：

1. 浏览器打开 <https://account.xiaomi.com/> 或 <https://i.mi.com/>，正常登录（该输验证码就输）；
2. F12 打开开发者工具 → **Network**（勾上 Preserve log），登录过程中找 `serviceLoginAuth2` 请求，
   它的 **Response** 里有 `"ssecurity": "..."`（还有 `userId`）；
3. 随便点一个发往 `api.io.mi.com` 的请求，**Request Headers** 里的
   `Cookie: serviceToken=...; userId=...` 就是另外两个值。

也可以只贴 Cookie：

```bash
node tools/probe.mjs session --cookie 'serviceToken=...; userId=...' --ssecurity '...'
```

环境变量等价：`XIAOMI_SERVICE_TOKEN`、`XIAOMI_SSECURITY`、`XIAOMI_USER_ID`。
`serviceToken` 一般 30 天有效，过期后重新走一遍上面的步骤即可。

**备选：账号 + 密码**

```bash
node tools/probe.mjs login --user '你的小米账号' --password '你的密码'
```

密码只用于这一次登录，不进配置。若小米要求验证码，探针会把验证码图存到
`$DSH_HOME/reboot-resume/<profile>/login-captcha.png`，重新运行 `login --icode <验证码>` 即可（会话 cookie
会保留）。

拿到缓存后做只读检查，并可选地手动开关一次插座：

```bash
node tools/probe.mjs status      # 型号 / IP / 继电器状态
node tools/probe.mjs on
node tools/probe.mjs off --yes   # 会真的断电，必须显式加 --yes
```

### 配置字段

```yaml
coldBoot:
  enabled: true
  plug:
    host: ''            # 留空则用云端/缓存里的 localip；可写 "IP:端口"
    token: ''           # 留空则用缓存 token；建议留空
    selector: { did: '', name: '插座', model: '' }   # 多设备时用来选中一个
    switch: { siid: 2, piid: 1 }   # MIoT 开关属性；老型号自动回退 get_prop/set_power
  account:
    username: ''        # 仅首次登录用；密码来自 XIAOMI_PASSWORD 或 DSH 凭据
  haltCommand: [systemctl, poweroff]   # 干净关机；也可用 ['sudo','-n','systemctl','poweroff']
  shutdownGraceSeconds: 5              # 关机前缓冲，让工具结果先落盘
  powerCutDelaySeconds: 30             # 关机开始后多久断电（等关机真正完成）
  outageSeconds: 30                    # 断电保持多久（等电源放电）
  restore:
    mode: jump          # manual | command | jump
    jump: { host: 'admin@192.168.8.2', identity: '/home/hong/.ssh/dsh_jump' }
    leadSeconds: 120
  allowManualRestore: true   # mode=manual 时必须显式打开，否则拒绝
```

`restore.mode` 三种取值：

| mode | 谁负责断电/上电 | 适用 |
| --- | --- | --- |
| `jump` | 常开 SSH 主机：收两份预签名云端请求，`sleep` 后分别发出 | 推荐，当前配置 |
| `command` | 本机在关机前执行一条 argv，由它自己安排后续 | 已有自定义脚本 |
| `manual` | 人工把插座打开 | 临时/调试，需 `allowManualRestore: true` |

`restore.mode: command` 的约定：命令必须**很快返回**（超时 15 秒），并把"关机后断电、N 秒后上电"交给外部机器：

```yaml
restore:
  mode: command
  command:
    - ssh
    - jump@192.168.8.2
    - nohup sh -c 'sleep 35; <断电命令>; sleep 30; <上电命令>' >/dev/null 2>&1 &
```

命令非零退出时，冷启动会在关机前中止并回滚计划任务与状态文件。

### 插座协议

本地控制走 miIO UDP 54321，两种 RPC 都支持，插件会自动选：

| 型号 | 读 | 写 |
| --- | --- | --- |
| MIoT 设备（如 `chuangmi.plug.212a01`，米家智能插座2） | `get_properties [{siid:2,piid:1}]` | `set_properties [{siid:2,piid:1,value:true/false}]` |
| 老型号（`chuangmi.plug.m1/v1/v3` 等） | `get_prop ["power"]` | `set_power ["on"/"off"]` |

`probe status` 会打印实际使用的 `protocol`（`miot` 或 `legacy`）。MIoT 型号的开关属性默认 `siid 2 / piid 1`，
换型号如果读不到状态，改 `plug.switch` 即可。

> 注意：miIO 命令的时间戳必须用**设备自己的时钟**（握手返回的 stamp），不能用 Unix 时间；否则设备会静默丢弃命令。

### 跳板机（恢复上电）

关机之后本机没有任何代码能执行，所以"断电"和"上电"都必须由一台常开设备完成。插件对跳板机的要求很低：

- 能 **SSH 免密登录**（key 认证，非交互）；
- 有 **`openssl`** 和 **`base64`**（BusyBox 路由器就够，不需要 `nc`、python 或编译器）；
- 能访问 `api.io.mi.com`（HTTPS）。

原理：插件在**关机前**把"断电"和"上电"各签成一个完整的 HTTPS 请求（`/app/miotspec/prop/set`），
连同 `openssl s_client` 的调用一起经 SSH 丢给跳板机。跳板机执行：

```sh
sleep (shutdownGrace + powerCutDelay)   # 等关机真正完成
openssl s_client ... < /tmp/dsh_plug_off.bin   # 断电
sleep outage                                   # 等电源放电
openssl s_client ... < /tmp/dsh_plug_on.bin    # 上电
```

签名在几分钟内有效（实测延迟 45 秒仍返回 `code:0`），`shutdownGrace + powerCutDelay + outage` 一般在 65 秒内，足够安全。

```yaml
restore:
  mode: jump
  jump:
    host: admin@192.168.8.2                 # SSH 目标
    identity: /home/hong/.ssh/dsh_jump     # 私钥
    apiHost: api.io.mi.com
    sshOptions: ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=8"]
```

当前机器用的是 `192.168.8.2` 的 Padavan 路由器（RT-AC54U），已实测：

```bash
# 1) 生成专用 key（一次性）
ssh-keygen -t ed25519 -f ~/.ssh/dsh_jump -N '' -C 'dsh-reboot-resume jump host'

# 2) 把公钥写到路由器上
#    /etc/storage/dsh_authorized_keys    （要 save 才进 flash）
#    /home/root/.ssh/authorized_keys     （运行时；/home 与 /etc 都是 tmpfs，重启会丢）
#    并在 /etc/storage/started_script.sh 末尾追加一段开机恢复脚本
#
# 3) 关键一步：Padavan 的 /etc/storage 在 tmpfs 上，必须提交到 flash，
#    否则路由器一重启 key 和开机脚本就没了（症状：Permission denied (publickey,password)）
/sbin/mtd_storage.sh save

# 4) 验证
ssh -i ~/.ssh/dsh_jump -o BatchMode=yes admin@192.168.8.2 \
  'openssl version >/dev/null 2>&1 && echo ok | base64 >/dev/null 2>&1 && echo dsh-jump-ok'
```

> Padavan 的 busybox `sh` 里**没有 `command` 内建**（`command -v` 会报 not found），所以预检用"直接执行"的方式探测工具。

要撤销这套改动：删掉 `/etc/storage/dsh_authorized_keys`、`/home/root/.ssh/authorized_keys`，
以及 `started_script.sh` 里 `# >>> dsh-reboot-resume jump host >>>` 那一段，并删除 `~/.ssh/dsh_jump*`。

> ⚠️ 这台路由器（Padavan）的 `/etc`、`/home` 都是 tmpfs。只写 `/etc/storage` **不会**持久化，
> 必须 `/sbin/mtd_storage.sh save`（等价于 Web 界面的"保存设置"）。我在 2026-11-25 首次配置时漏了这一步，
> 路由器在 11-28 重启后 key 与开机脚本一起消失，冷启动的跳板机预检就报
> `admin@192.168.8.2: Permission denied (publickey,password)`。11-28 已补装并 save 成功。

**失败模式**：跳板机没执行、云端会话过期（`serviceToken` 约 30 天）或插座离线时，电脑会停在断电状态，
需要人工上电。`dry_run` 会先检查云端会话、SSH 可达性和跳板机工具，把这三类问题挡在断电之前。

> 不要用"插座定时反复开关直到电脑起来"的做法：电脑没起来时会无限重启，插件也刻意不实现它。

> ⚠️ 当前 profile 的组合是 `restore.mode: manual` + `allowManualRestore: true`，同时 `allowUnattended: true`。
> 也就是说模型可以在**不弹审批**的情况下断电，然后等你手动把插座打开。跳板机就绪后请改成
> `restore.mode: command`；在那之前如果不想承担这个风险，把 `allowManualRestore` 改回 `false`（工具会直接拒绝冷启动）。

### 模型怎么调用

工具名：`system_cold_boot`。除通用参数（`reason` 必填，`resume_prompt`、`target_session`、`dry_run` 可选）外，
每次调用还可以覆盖三个时间参数——**按单次任务自由设置，不需要改配置**：

| 参数 | 范围 | 默认（配置值） | 含义 |
| --- | --- | --- | --- |
| `shutdown_grace_seconds` | 2–60 | 5 | 调用关机前的缓冲，保证工具结果先落盘 |
| `power_cut_delay_seconds` | 10–300 | 30 | 关机开始后多久断电；太小会切断仍在关机的系统 |
| `outage_seconds` | 10–600 | 30 | 断电保持多久（等电源放电，保证 BIOS 认为是冷启动） |

越界值会被**夹取**到范围内（不会报错），非整数/非正数会被拒绝（`invalid_arguments`）。
不传就用 `coldBoot` 里的配置值，所以"默认时序"和"按次自定义"可以共存。

```json
{
  "reason": "PCIe 设备需要冷启动重新枚举，这次多放一会儿电",
  "power_cut_delay_seconds": 40,
  "outage_seconds": 60
}
```

跳板机的时序由这三个值派生：`sleep (shutdown_grace + power_cut_delay)` 后断电，再 `sleep outage` 后上电；
兜底计划任务按 `shutdown_grace + power_cut_delay + outage + fallbackDelaySeconds` 到期。

`dry_run` 会返回：插座信息（掩码后的 token 状态）、继电器状态、`restore.mode`、生效的 `timings`、
以及 `plan.blockers`（为什么现在不能冷启动）和 `plan.warnings`。常见返回码：

`dry_run` 会返回：插座信息（掩码后的 token 状态）、继电器状态、`restore.mode`、以及 `plan.blockers`
（为什么现在不能冷启动）和 `plan.warnings`。常见返回码：

| code | 含义 |
| --- | --- |
| `cold_boot_ready` | dry run 通过，可以正式调用 |
| `cold_boot_started` | 已断电，续跑已排入队列 |
| `cold_boot_blocked` | 前置条件不满足（插座不可达 / 状态不是 on / 没有恢复手段） |
| `restore_failed` | 外部恢复命令失败，已在断电前中止 |
| `power_off_failed` | 插座断电命令失败，已回滚并尝试恢复上电 |
| `cold_boot_disabled` | `coldBoot.enabled` 为 false |

### 环境前提

- 插座和本机在同一局域网；miIO 走 UDP 54321，不需要云端在线（token 缓存在本地）。
- BIOS 需要设置「断电恢复后自动开机 / Restore AC Power Loss = Power On」，否则上电后不会自动启动。
- `dsh-web.service` 已 enabled，DSH 会随登录自动起来；启动钩子负责立刻续跑。

## polkit 权限（重启 / 关机被挡时看这里）

`system_reboot` / `system_cold_boot` 执行前都会用 `busctl ... CanReboot` / `CanPowerOff` 预检。
PolicyKit 的默认策略是：

```
<allow_active>yes</allow_active>          # 有活动本地会话 → 直接放行
<allow_inactive>auth_admin_keep</allow_inactive>   # 否则需要交互认证
```

DSH 是 **systemd user service**（`dsh-web.service`），自己没有 logind session
（`loginctl session-status <dsh pid>` 会报 `No session known`），所以它走的是
`auth_admin_keep` 分支：只有在刚刚交互认证过、临时授权还没过期时才会返回 `yes`，
过期后就变成 `challenge` → 插件按设计拒绝执行并报"需要交互认证"。

这就是"有时能重启、有时被 polkit 挡"的原因。固定放行的做法（需要 root，一次性）：

```bash
sudo install -m 0644 docs/polkit/49-dsh-power.rules /etc/polkit-1/rules.d/
```

规则只对 `org.freedesktop.login1.reboot` / `power-off`（含 multiple-sessions 变体）放行，
且只对 DSH 的运行用户生效；文件里写的是 `hong`，换用户要改 `DSH_USER`。

验证：

```bash
DSH_PID=$(systemctl --user show -p MainPID --value dsh-web.service)
pkcheck --action-id org.freedesktop.login1.reboot --process "$DSH_PID"; echo $?   # 0 = 放行
pkcheck --action-id org.freedesktop.login1.power-off --process "$DSH_PID"; echo $? # 0 = 放行
```

撤销：`sudo rm /etc/polkit-1/rules.d/49-dsh-power.rules`。

替代方案：给该用户配 `NOPASSWD` 的 `systemctl reboot` / `systemctl poweroff`，然后把
`rebootCommand` 和 `coldBoot.haltCommand` 都改成 `['sudo','-n','systemctl',...]`。

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

```bash
cd /home/hong/Documents/deepseek-harness/default-workspace/plugin-src/reboot-resume
node --test test/
```

假插座用真实 miIO 报文（握手、MD5 校验、AES-128-CBC）跑协议层，再用假 Cordis 上下文（tools / systemPrompt /
Schedule / 审批）加载插件本体，覆盖：dry run 不动作、成功冷启动的顺序（排续跑 → 写 pending → 执行恢复命令 →
断电）、恢复命令失败时断电前回滚、没有恢复手段时拒绝、错误 token 被拒、以及重启续跑的既有逻辑。

不接插座也可以只验证控制流程：

```bash
node tools/probe.mjs status --host 192.168.8.x --token <32位token>
```

## 文件

- `index.js`：工具、审批、权限预检、计划任务、状态文件、启动续跑、`events.jsonl` 诊断日志。
- `lib/miio.js`：miIO 本地协议（握手、MD5 校验、AES-128-CBC 命令），无第三方依赖。
- `lib/xiaomi-cloud.js`：小米账号登录与设备列表（取 `localip` + `token`）。
- `lib/plug.js`：插座解析（配置 → 缓存 → 云端）、状态与开关。
- `lib/cold-boot.js`：冷启动前置检查、恢复策略、恢复命令执行。
- `tools/probe.mjs`：不进 DSH 也能用的探针（session/login/list/status/on/off）。
- `test/`：假插座 + 假 Cordis 上下文的协议与流程测试（`node --test test/`）。
- `cordis.patch.yml`：bundle 的 Loader patch。
- `locale/en.json`、`locale/zh.json`：插件管理条目文案。
- `icon.svg`：插件图标。
