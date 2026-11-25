/**
 * Cold-boot planning.
 *
 * A cold boot differs from `system_reboot` in one important way: the machine
 * loses power, so nothing running on it can turn the power back on. That makes
 * the restore path the load-bearing part of this feature, and the reason this
 * module refuses to plan a cold boot without one.
 *
 * The plugin never implements the "keep toggling the plug until the PC boots"
 * trick: a machine that fails to POST would reboot forever. It requires either
 *
 *   - `restore.mode: command` — an argv run locally before the power cut that
 *     arranges the power-on out-of-band (for example an ssh command to a jump
 *     host that sleeps, then powers the plug back on); or
 *   - `restore.mode: manual` plus `allowManualRestore: true` — the user turns
 *     the plug back on by hand.
 */

import path from 'node:path';

/**
 * Normalize the `coldBoot` configuration block.
 * @param raw - Raw `coldBoot` object from the Loader row config.
 * @param defaults - Plugin-level defaults (`home`, `profile`, `pendingDir`).
 * @returns Normalized cold-boot settings.
 */
export function normalizeColdBoot(raw, defaults) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const plug = source.plug !== null && typeof source.plug === 'object' ? source.plug : {};
  const selector = plug.selector !== null && typeof plug.selector === 'object' ? plug.selector : {};
  const account = source.account !== null && typeof source.account === 'object' ? source.account : {};
  const restore = source.restore !== null && typeof source.restore === 'object' ? source.restore : {};

  const mode = restore.mode === 'command' ? 'command' : restore.mode === 'jump' ? 'jump' : 'manual';
  const command = Array.isArray(restore.command)
    ? restore.command.filter((part) => typeof part === 'string' && part !== '')
    : [];
  const jump = restore.jump !== null && typeof restore.jump === 'object' ? restore.jump : {};

  return {
    enabled: source.enabled === true,
    plug: {
      host: typeof plug.host === 'string' ? plug.host.trim() : '',
      token: typeof plug.token === 'string' ? plug.token.trim() : '',
      selector: {
        did: typeof selector.did === 'string' ? selector.did.trim() : '',
        name: typeof selector.name === 'string' ? selector.name.trim() : '',
        model: typeof selector.model === 'string' ? selector.model.trim() : '',
      },
      // MIoT spec ids of the relay; 2/1 is the switch on almost every plug.
      switch: {
        siid: Number.isInteger(plug.switch?.siid) ? plug.switch.siid : 2,
        piid: Number.isInteger(plug.switch?.piid) ? plug.switch.piid : 1,
      },
    },
    account: {
      username: typeof account.username === 'string' ? account.username.trim() : '',
      // The password is read from the environment or the DSH credential store;
      // accepting it here as well keeps local probes simple.
      password: typeof account.password === 'string' ? account.password : '',
    },
    haltCommand: normalizeCommand(source.haltCommand) ?? ['systemctl', 'poweroff'],
    restore: {
      mode,
      command: mode === 'command' ? command : [],
      // Jump host: an always-on SSH host with openssl + base64 that sends the
      // pre-signed power-on request after the outage.
      jump: {
        host: typeof jump.host === 'string' ? jump.host.trim() : '',
        identity: typeof jump.identity === 'string' ? jump.identity.trim() : '',

        apiHost: typeof jump.apiHost === 'string' && jump.apiHost.trim() !== ''
          ? jump.apiHost.trim()
          : 'api.io.mi.com',
        sshOptions: Array.isArray(jump.sshOptions)
          ? jump.sshOptions.filter((option) => typeof option === 'string' && option !== '')
          : ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8'],
      },
      leadSeconds: clampInteger(restore.leadSeconds, 120, 10, 3600),
    },
    // Wait before invoking poweroff, so the tool result and closed turn reach
    // durable storage before systemd stops us.
    shutdownGraceSeconds: clampInteger(source.shutdownGraceSeconds, 5, 2, 60),
    // After the shutdown starts: how long before mains power is cut, so the
    // shutdown really finished. Cutting power mid-shutdown risks data loss.
    powerCutDelaySeconds: clampInteger(source.powerCutDelaySeconds, 30, 10, 300),
    // How long the machine stays unpowered: the PSU must fully discharge or
    // the next power-on may not register as a cold boot in the BIOS.
    outageSeconds: clampInteger(source.outageSeconds, 30, 10, 600),
    allowManualRestore: source.allowManualRestore === true,
    cacheFile: path.join(defaults.pendingDir, 'plug.json'),
  };
}

/**
 * Normalize an argv command.
 * @param value - Array or whitespace-separated string.
 * @returns A non-empty argv array, or null when absent/invalid.
 */
function normalizeCommand(value) {
  if (Array.isArray(value)) {
    const parts = value.filter((part) => typeof part === 'string' && part !== '');
    return parts.length === value.length && parts.length > 0 ? parts : null;
  }
  if (typeof value === 'string' && value.trim() !== '') return value.trim().split(/\s+/);
  return null;
}

/**
 * Bound an integer into a range.
 * @param value - Candidate value.
 * @param fallback - Value used when the candidate is not a finite number.
 * @param min - Lowest accepted value.
 * @param max - Highest accepted value.
 * @returns Clamped integer.
 */
function clampInteger(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Resolve the timings for one call, letting a caller override the configured
 * values within safe bounds.
 *
 * @param coldBoot - Normalized cold-boot config (configured defaults).
 * @param overrides - Optional per-call values in seconds.
 * @returns Effective shutdown grace, power-cut delay, and outage.
 */
export function effectiveTimings(coldBoot, overrides = {}) {
  const source = overrides !== null && typeof overrides === 'object' ? overrides : {};
  return {
    // Keep the result and the closed turn on disk before systemd stops us.
    shutdownGraceSeconds: clampInteger(source.shutdownGraceSeconds, coldBoot.shutdownGraceSeconds, 2, 60),
    // Cutting power mid-shutdown risks the filesystem, so never allow a short
    // window here.
    powerCutDelaySeconds: clampInteger(source.powerCutDelaySeconds, coldBoot.powerCutDelaySeconds, 10, 300),
    // The PSU must discharge or the BIOS may not register a power-on.
    outageSeconds: clampInteger(source.outageSeconds, coldBoot.outageSeconds, 10, 600),
  };
}

/**
 * Decide whether a cold boot may proceed, and describe what will happen.
 * @param options - Cold-boot config, plug status, and whether a restore plan exists.
 * @returns Blockers (must be empty to proceed), warnings, and the ordered plan.
 */
export function planColdBoot({ coldBoot, plugStatus }) {
  const blockers = [];
  const warnings = [];
  const steps = [];

  if (!coldBoot.enabled) {
    blockers.push('冷启动未启用：请在配置里设置 coldBoot.enabled = true。');
  }
  if (plugStatus === null || plugStatus === undefined) {
    blockers.push('插座状态不可用：无法连接到插座。');
  } else if (plugStatus.power !== 'on') {
    blockers.push(`插座当前状态为 ${plugStatus.power}，预期是 on；为避免误操作，未安排冷启动。`);
  }

  if (coldBoot.restore.mode === 'jump') {
    const jump = coldBoot.restore.jump;
    if (jump.host === '') {
      blockers.push('restore.mode 为 jump，但 restore.jump.host 为空（例如 admin@192.168.8.2）。');
    } else {
      steps.push(`经 SSH 把断电/上电两份预签名请求交给跳板机 ${jump.host}`);
    }
  } else if (coldBoot.restore.mode === 'command') {
    if (coldBoot.restore.command.length === 0) {
      blockers.push('restore.mode 为 command，但 restore.command 为空。');
    } else {
      steps.push(`先执行外部恢复命令：${coldBoot.restore.command.join(' ')}`);
    }
  } else if (coldBoot.allowManualRestore) {
    warnings.push('恢复方式为手动：断电后需要你手动把插座打开，电脑才会重新启动。');
  } else {
    blockers.push(
      '没有可用的恢复手段：本机断电后无法自行上电。请配置 restore.mode=command（跳板机），'
      + '或显式设置 coldBoot.allowManualRestore=true 承认需要人工上电。',
    );
  }

  if (coldBoot.outageSeconds < 20) {
    warnings.push(`断电时间 ${coldBoot.outageSeconds}s 偏短，电源可能没有完全放电，冷启动可能不彻底。`);
  }
  if (coldBoot.powerCutDelaySeconds < 20) {
    warnings.push(
      `关机后 ${coldBoot.powerCutDelaySeconds}s 就断电，关机可能还没完成；建议 30s 左右。`,
    );
  }

  steps.push(
    `安排续跑计划任务（兜底），写入 pending.json`,
    `把断电/上电两份预签名请求交给恢复手段（${coldBoot.restore.mode}）`,
    `本机执行关机（${coldBoot.haltCommand.join(' ')}），缓冲 ${coldBoot.shutdownGraceSeconds}s`,
    `关机开始约 ${coldBoot.powerCutDelaySeconds}s 后由恢复手段把插座 ${plugStatus?.host ?? ''} 断电`,
    `断电 ${coldBoot.outageSeconds}s（等电源放电）后由恢复手段上电`,
    `BIOS 上电自启，DSH 启动时按 boot id 检测到新启动并立即续跑`,
  );

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    steps,
    estimated: {
      shutdownGraceSeconds: coldBoot.shutdownGraceSeconds,
      powerCutAfterSeconds: coldBoot.powerCutDelaySeconds,
      outageSeconds: coldBoot.outageSeconds,
      powerOnAfterSeconds: coldBoot.shutdownGraceSeconds + coldBoot.powerCutDelaySeconds + coldBoot.outageSeconds,
      bootEstimateSeconds: 60,
    },
  };
}

/**
 * Run the restore command locally before the power cut.
 * @param options - Command argv, timeout, and logger.
 * @returns Exit information; the caller aborts the cold boot on failure.
 */
export async function runRestoreCommand({ command, timeoutMs = 15000, execFile, log }) {
  if (!Array.isArray(command) || command.length === 0) {
    return { ok: false, detail: '恢复命令为空' };
  }
  const [executable, ...args] = command;
  const outcome = await runCapture({ executable, args, timeoutMs, execFile });
  if (!outcome.ok) {
    log?.warn?.(`restore command failed: ${outcome.detail}`);
  }
  return outcome;
}

/**
 * Execute one argv with a hard timeout.
 * @param options - Executable, arguments, timeout, and an execFile implementation.
 * @returns Normalized result.
 */
function runCapture({ executable, args, timeoutMs, execFile }) {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error !== null && error !== undefined) {
          resolve({
            ok: false,
            exitCode: typeof error.code === 'number' ? error.code : null,
            detail: String(stderr ?? '').trim() || error.message || '恢复命令执行失败',
          });
          return;
        }
        resolve({ ok: true, exitCode: 0, detail: String(stdout ?? '').trim() });
      },
    );
  });
}
