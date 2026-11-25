/**
 * Reboot and resume — a Host bundle for DeepSeek Harness.
 *
 * It registers the model-facing `system_reboot` tool. A successful call:
 *
 * 1. asks the user for one-shot approval;
 * 2. verifies that PolicyKit (or `sudo -n`) will let this process reboot;
 * 3. creates a durable one-shot Schedule task whose prompt is the continuation;
 * 4. writes a pending-reboot record containing the pre-reboot boot id;
 * 5. starts a delayed `systemctl reboot` and ends the current turn.
 *
 * After the machine starts and DSH loads this plugin again, the startup hook
 * compares the current boot id with the recorded one. On a new boot it runs
 * the Schedule task immediately and removes it; the Schedule task is also a
 * fallback for the case where the fast path cannot run. The tool itself never
 * reboots unless approval succeeded and the state was armed first.
 *
 * The plugin is Host-only and Linux/systemd-oriented. It uses the Schedule
 * service for durable delivery, so it stays inert when that service is not
 * composed.
 */

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { effectiveTimings, normalizeColdBoot, planColdBoot, runRestoreCommand } from './lib/cold-boot.js';
import { armJumpRestore, buildPowerRequest, preflightJump } from './lib/jump-host.js';
import { plugStatus, readCache, resolvePlug } from './lib/plug.js';
import { cloudGetProperty } from './lib/xiaomi-cloud.js';

/** Loader plugin name. */
export const name = 'reboot-resume';
/** Host services required before the tool and startup hook are installed. */
export const inject = ['tools', 'systemPrompt'];

/** Model-facing tool name. */
const TOOL_NAME = 'system_reboot';
/** Version of the on-disk pending record. */
const STATE_VERSION = 1;
/** Maximum accepted `reason` length in Unicode code points. */
const MAX_REASON = 2000;
/** Maximum accepted `resume_prompt` length in Unicode code points. */
const MAX_RESUME_PROMPT = 8000;
/** Schedule and prompt-title limit enforced by the Schedule service. */
const MAX_TITLE = 120;
/** Maximum reason text embedded in the approval prompt. */
const MAX_APPROVAL_REASON = 500;
/** Default reboot command; config may replace it with an argv array. */
const DEFAULT_REBOOT_COMMAND = ['systemctl', 'reboot'];
/** Tool description used when the profile keeps the approval prompt. */
const TOOL_DESCRIPTION_ASK =
  'Restart the whole computer and automatically continue this session after DeepSeek Harness starts again. '
  + 'Use only when the user explicitly asks to reboot, or when the current task genuinely cannot proceed without a '
  + 'system reboot (for example a kernel, driver, or firmware change). The call asks the user for approval, arms a '
  + 'durable continuation message in this session, then runs the configured reboot command after a short delay. '
  + 'After the machine restarts, the continuation starts a new turn here and the agent resumes the interrupted task. By default the continuation resumes the calling chat; set `target_session` to resume another existing chat where the interrupted task lives. '
  + 'Rebooting interrupts every running application and may lose unsaved work; the approval prompt states this. '
  + 'Do not use this tool to restart only DSH. Set `dry_run` to check reboot permission without changing anything.';

/** Tool description used when the profile explicitly allows unattended reboots. */
const TOOL_DESCRIPTION_UNATTENDED =
  'Restart the whole computer and automatically continue this session after DeepSeek Harness starts again. '
  + 'Use only when the user explicitly asks to reboot, or when the current task genuinely cannot proceed without a '
  + 'system reboot (for example a kernel, driver, or firmware change). This profile is configured to allow '
  + 'unattended reboots, so the call does not ask for approval; it arms a durable continuation message in this '
  + 'session, then runs the configured reboot command after a short delay. After the machine restarts, the '
  + 'continuation starts a new turn here and the agent resumes the interrupted task. By default the continuation resumes the calling chat; set `target_session` to resume another existing chat where the interrupted task lives. Rebooting interrupts every '
  + 'running application and may lose unsaved work. Do not use this tool to restart only DSH. Set `dry_run` to '
  + 'check reboot permission without changing anything.';

/** System-prompt guidance used when approvals are enabled. */
const SYSTEM_PROMPT_ASK =
  '`system_reboot` restarts the whole computer and arms an automatic continuation of this session. Use it only when '
  + 'the user explicitly asks to reboot or when the current task cannot proceed without one; it always asks for '
  + 'approval. Never claim a reboot happened before the tool returns `reboot_scheduled`. After the restart an '
  + 'automatic continuation message arrives in this session; do not schedule another reminder for the same reboot.';

/** System-prompt guidance used when the profile allows unattended reboots. */
const SYSTEM_PROMPT_UNATTENDED =
  '`system_reboot` restarts the whole computer and arms an automatic continuation of this session. Use it only when '
  + 'the user explicitly asks to reboot or when the current task cannot proceed without one. This profile allows '
  + 'unattended reboots, so the tool does not prompt; still do not restart speculatively. Never claim a reboot '
  + 'happened before the tool returns `reboot_scheduled`. After the restart an automatic continuation message '
  + 'arrives in this session; do not schedule another reminder for the same reboot.';

/** Model-facing tool name for the cold boot (mains power cycle). */
const COLD_BOOT_TOOL_NAME = 'system_cold_boot';

/** Tool description for the cold boot tool. */
const COLD_BOOT_DESCRIPTION =
  'Cold-boot the whole computer: shut it down cleanly, cut mains power through a Wi-Fi smart plug once the shutdown '
  + 'finished, restore power after the PSU has discharged, then continue this session automatically after DeepSeek '
  + 'Harness starts again. Use it only when the user explicitly asks for a cold boot or when a warm reboot is not '
  + 'enough (for example PCIe or GPU devices that only re-enumerate after AC power loss). The call arms a durable '
  + 'continuation, then hands the delayed power cut and restore to the configured out-of-band restore path, then '
  + 'shuts the machine down; the machine cannot power itself back on. Never claim anything happened before the tool '
  + 'returns `cold_boot_started`. Set `dry_run` to inspect the plug, the restore path, and the planned sequence '
  + 'without changing anything. `shutdown_grace_seconds`, `power_cut_delay_seconds`, and `outage_seconds` override '
  + 'the profile timings for this one call (clamped to safe ranges) when the task needs a shorter or longer outage.';

/** System-prompt guidance for the cold boot tool. */
const COLD_BOOT_PROMPT =
  '`system_cold_boot` shuts the machine down, then a smart plug cuts mains power and restores it; the computer '
  + 'cannot turn itself back on, so the configured jump host or the user must restore power. Use it only when a warm '
  + 'reboot cannot solve the problem. Never claim a cold boot happened before the tool returns `cold_boot_started`. '
  + 'Set `dry_run` to check the plug, the restore path, and the polkit permission first.';

/**
 * Select the model-facing description for the configured approval mode.
 * @param config - Resolved config.
 * @returns Tool description.
 */
function toolDescription(config) {
  return config.allowUnattended ? TOOL_DESCRIPTION_UNATTENDED : TOOL_DESCRIPTION_ASK;
}

/**
 * Select the system-prompt guidance for the configured approval mode.
 * @param config - Resolved config.
 * @returns System-prompt section text.
 */
function systemPromptFor(config) {
  return config.allowUnattended ? SYSTEM_PROMPT_UNATTENDED : SYSTEM_PROMPT_ASK;
}

/** Raw JSON Schema for the arguments. */
const PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: {
      type: 'string',
      description:
        'Short human-readable reason for the reboot. It is shown in the approval prompt when approvals are '
        + 'enabled and stored in the continuation message so the resumed agent knows why the machine restarted.',
    },
    resume_prompt: {
      type: 'string',
      description:
        'Optional instructions for the turn that starts after the reboot. Omit to continue from the conversation '
        + 'history with a generated continuation prompt.',
    },
    target_session: {
      type: 'string',
      description:
        'Optional id of an existing top-level session to resume. Omit to resume the calling session. Use this '
        + 'when the interrupted task lives in another chat, for example session-... . The target must exist, must '
        + 'not be archived, and must not be a delegated subagent session.',
    },
    dry_run: {
      type: 'boolean',
      description:
        'When true, check the pending state and reboot permission, then report what would happen without '
        + 'scheduling a continuation or rebooting.',
    },
  },
  required: ['reason'],
};

/** Raw JSON Schema for the cold-boot arguments (timings are per-call overridable). */
const COLD_BOOT_PARAMETERS_SCHEMA = {
  ...PARAMETERS_SCHEMA,
  properties: {
    ...PARAMETERS_SCHEMA.properties,
    shutdown_grace_seconds: {
      type: 'integer',
      minimum: 2,
      maximum: 60,
      description:
        'Seconds between starting the shutdown and the host actually going down, so the tool result reaches durable '
        + 'storage first. Defaults to the profile value (5). Allowed range 2-60.',
    },
    power_cut_delay_seconds: {
      type: 'integer',
      minimum: 10,
      maximum: 300,
      description:
        'Seconds after the shutdown starts before the plug cuts mains power. Must be long enough for the shutdown to '
        + 'finish; values below 10 are rejected. Defaults to the profile value (30).',
    },
    outage_seconds: {
      type: 'integer',
      minimum: 10,
      maximum: 600,
      description:
        'Seconds the machine stays unpowered so the PSU fully discharges. Too short and the BIOS may not treat the '
        + 'next power-on as a cold boot. Defaults to the profile value (30).',
    },
  },
};

/** Raw JSON Schema for the canonical result. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    code: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['ok'],
};

/**
 * Install either the Host startup hook (the profile bundle instance) or the
 * model-facing tool (the preset instance added by {@link ensurePresetToolRow}).
 * @param ctx - Host or preset plugin context.
 * @param rawConfig - Resolved row config.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const stateFile = path.join(config.pendingDir, 'pending.json');
  const log = typeof ctx.logger === 'function' ? ctx.logger('reboot-resume') : (ctx.logger ?? console);

  ctx.inject(['schedule'], (scoped) => {
    const deps = { config, stateFile, log, schedule: scoped.schedule };

    if (config.toolOnly) {
      registerTool(scoped, deps);
      registerPromptSection(scoped, deps);
      return;
    }

    // Host instance: the startup hook lives here, while the model-visible tool
    // must be composed by the agent preset. Add that row once through the
    // supported configuration editor, then let the preset reconciliation mount
    // the tool in the agent's own scope.
    if (config.ensurePreset) {
      scoped.effect(() => {
        const timer = setTimeout(() => {
          void ensurePresetToolRow(scoped, config, log).catch((error) => {
            log.warn(`could not add the reboot tool to the standard preset: ${safeErrorMessage(error)}`);
          });
        }, 2000);
        timer.unref?.();
        return () => clearTimeout(timer);
      }, 'reboot-resume: ensure preset tool row');
    }

    scoped.effect(() => {
      void resumeAfterBoot(scoped.schedule, deps).catch((error) => {
        log.warn(`startup continuation check failed: ${safeErrorMessage(error)}`);
      });
      return () => {};
    }, 'reboot-resume: startup continuation check');
  });
}

/**
 * Register the model-facing guidance beside the tool.
 * @param ctx - Preset scope that owns the tool.
 * @param deps - Resolved config, state path, logger, and Schedule service.
 */
function registerPromptSection(ctx, deps) {
  let order = 600;
  try {
    const scheduleOrder = ctx.systemPrompt.getSectionOrder('TOOL_SCHEDULE');
    if (Number.isFinite(scheduleOrder)) order = scheduleOrder + 1;
  } catch {
    // The Schedule tool's section order is unavailable in this composition.
  }
  ctx.systemPrompt.section({
    name: 'tool:system-reboot',
    order,
    text: ({ scope }) => {
      try {
        return ctx.tools.get(TOOL_NAME, scope) === undefined ? '' : systemPromptFor(deps.config);
      } catch {
        return '';
      }
    },
  });
  if (deps.config.coldBoot.enabled) {
    ctx.systemPrompt.section({
      name: 'tool:system-cold-boot',
      order: order + 1,
      text: ({ scope }) => {
        try {
          return ctx.tools.get(COLD_BOOT_TOOL_NAME, scope) === undefined ? '' : COLD_BOOT_PROMPT;
        } catch {
          return '';
        }
      },
    });
  }
}

/**
 * Append the tool's preset row to the standard agent preset through the
 * supported configuration editor. The edit is idempotent.
 * @param ctx - Schedule-resolved Host scope.
 * @param config - Resolved Host config.
 * @param log - Plugin logger.
 */
async function ensurePresetToolRow(ctx, config, log) {
  const editor = ctx.get('configEditor');
  if (editor === undefined || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
    log.warn('configEditor is unavailable; the reboot tool was not added to the agent preset');
    return;
  }
  const entry = editor.entries().find((candidate) => {
    const id = candidate?.options?.id;
    const name = candidate?.options?.name;
    return id === 'preset-standard' && name === '@deepseek-ai/dsh-agent-preset';
  });
  if (entry === undefined) {
    log.warn('the standard agent preset entry is not addressable; the reboot tool will not be visible to agents');
    return;
  }
  const toolRow = {
    id: 'tool-system-reboot',
    // The preset loader resolves bare package names from the dsh installation,
    // not the profile, so use the absolute file URL of this linked module.
    name: import.meta.url,
    config: {
      toolOnly: true,
      pendingDir: config.pendingDir,
      allowUnattended: config.allowUnattended,
      rebootCommand: config.rebootCommand,
      rebootDelaySeconds: config.rebootDelaySeconds,
      fallbackDelaySeconds: config.fallbackDelaySeconds,
      staleAfterSeconds: Math.round(config.staleMs / 1000),
      // The preset instance executes the tools, so it needs the cold-boot
      // settings too. The account password is deliberately not copied: the
      // host instance signs in and caches the plug token, and the preset
      // instance reads that cache or the credential store.
      coldBoot: {
        ...config.coldBoot,
        account: { ...config.coldBoot.account, password: '' },
      },
    },
  };
  await editor.edit(entry, (current, inherited) => {
    const currentPlugins = Array.isArray(current.plugins) ? current.plugins : undefined;
    const inheritedPlugins = Array.isArray(inherited.plugins) ? inherited.plugins : [];
    const base = (currentPlugins ?? inheritedPlugins).slice();
    const index = base.findIndex((row) => row !== null && typeof row === 'object' && row.id === toolRow.id);
    if (index >= 0) {
      // Always rewrite the row: an existing row with the same name can still
      // carry an older config (for example an older cold-boot timing), and
      // skipping the write would silently keep stale settings forever.
      base[index] = { ...toolRow };
      return { ...inherited, ...current, plugins: base };
    }
    return { ...inherited, ...current, plugins: [...base, toolRow] };
  });
  log.info('added the reboot tool to the standard agent preset');

  // The config edit can update the preset definition without recomposing
  // agents that were created before it. Recreate those compositions so the
  // model-visible tool table includes the new row.
  const presets = ctx.get('agentPresets');
  const agents = ctx.get('agents');
  if (presets !== undefined && agents !== undefined && typeof presets.recompose === 'function') {
    for (const agent of agents.list()) {
      try {
        const presetId = presets.presetForSession(agent.session);
        if (presetId === 'standard') await presets.recompose(agent.ctx, presetId);
      } catch (error) {
        log.warn(`could not recompose ${agent.session.id}: ${safeErrorMessage(error)}`);
      }
    }
  }

  // One-shot local diagnostic: record the live preset composition so a failed
  // nested plugin row can be told apart from a stale agent tool table.
  try {
    const presets = ctx.get('agentPresets');
    const inventory = presets !== undefined && typeof presets.compositionInventory === 'function'
      ? await presets.compositionInventory()
      : null;
    const inspections = presets !== undefined && typeof presets.inspectCompositions === 'function'
      ? presets.inspectCompositions()
      : null;
    await fs.mkdir(config.pendingDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(config.pendingDir, 'preset-debug.json'),
      `${JSON.stringify({
        module: import.meta.url,
        toolOnly: config.toolOnly,
        ensurePreset: config.ensurePreset,
        inventory,
        inspections,
      }, null, 2)}\n`,
      'utf8',
    );
  } catch (error) {
    log.warn(`could not write preset diagnostics: ${safeErrorMessage(error)}`);
  }
}

/**
 * Register the model-facing tool in one agent's scope.
 * @param ctx - Agent scope whose `tools` registry receives the tool.
 * @param deps - Resolved config, state path, logger, and Schedule service.
 * @returns The registry disposer.
 */
function registerTool(ctx, deps) {
  const { log } = deps;
  const disposers = [ctx.tools.register({
    name: TOOL_NAME,
    description: toolDescription(deps.config),
    parameters: PARAMETERS_SCHEMA,
    output: { schema: OUTPUT_SCHEMA, render },
    presentCall(rawArgs) {
      const reason = rawArgs && typeof rawArgs === 'object' && typeof rawArgs.reason === 'string'
        ? rawArgs.reason
        : undefined;
      return {
        card: 'generic',
        title: 'Reboot and resume',
        kind: 'other',
        rawInput: reason === undefined ? undefined : { reason },
      };
    },
    async execute(rawArgs, exec) {
      try {
        return await runTool(ctx, rawArgs, exec, deps);
      } catch (error) {
        log.error(`system_reboot failed: ${safeErrorMessage(error)}`);
        return fail('internal_error', '重启请求在安排重启前失败，未执行重启。');
      }
    },
  })];

  if (deps.config.coldBoot.enabled) {
    disposers.push(ctx.tools.register({
      name: COLD_BOOT_TOOL_NAME,
      description: COLD_BOOT_DESCRIPTION,
      parameters: COLD_BOOT_PARAMETERS_SCHEMA,
      output: { schema: OUTPUT_SCHEMA, render },
      presentCall(rawArgs) {
        const reason = rawArgs && typeof rawArgs === 'object' && typeof rawArgs.reason === 'string'
          ? rawArgs.reason
          : undefined;
        return {
          card: 'generic',
          title: 'Cold boot and resume',
          kind: 'other',
          rawInput: reason === undefined ? undefined : { reason },
        };
      },
      async execute(rawArgs, exec) {
        try {
          return await runColdBoot(ctx, rawArgs, exec, deps);
        } catch (error) {
          log.error(`system_cold_boot failed: ${safeErrorMessage(error)}`);
          return fail('internal_error', '冷启动请求在断电前失败，未执行断电。');
        }
      },
    }));
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        // A registry disposer that already ran is not an error here.
      }
    }
  };
}

/**
 * Validate arguments, obtain approval, arm the continuation, then reboot.
 * @param ctx - Schedule-resolved plugin scope.
 * @param rawArgs - Unvalidated model arguments.
 * @param exec - Tool execution identity and caller agent.
 * @param deps - Resolved config, state path, and logger.
 * @returns The canonical tool value.
 */
async function runTool(ctx, rawArgs, exec, deps) {
  const { config, stateFile, log } = deps;
  const parsed = parseArgs(rawArgs);
  if (parsed.kind === 'error') return fail('invalid_arguments', parsed.message);

  const agent = exec.agent;
  if (agent === undefined) return fail('no_agent', '重启工具需要一个活动的会话。');
  const callerSessionId = agent.session.id;
  const targetSessionId = parsed.targetSession === '' ? callerSessionId : parsed.targetSession;
  if (delegationDepth(agent) > 0) {
    return fail('subagent_session', '子代理不能重启电脑；请在主会话中执行。');
  }

  const bootId = await readBootId();
  let state = await inspectState(stateFile);
  if (state.kind === 'corrupt') {
    const cleared = await clearIfStaleCorrupt(stateFile, config, log);
    if (!cleared) {
      return fail(
        'reboot_state_unreadable',
        `重启续跑状态文件无法解析：${stateFile}。请检查或删除该文件后重试。`,
      );
    }
    state = { kind: 'none' };
  }
  if (state.kind === 'pending') {
    const record = state.record;
    if (record.resumedAt !== undefined) {
      await removeState(stateFile);
    } else {
      const age = Date.now() - Date.parse(record.createdAt);
      const sameBoot = record.bootId !== null && bootId !== null && record.bootId === bootId;
      if (sameBoot && Number.isFinite(age) && age > config.staleMs) {
        // The reboot never happened and the record is old: clear it so this
        // call can proceed instead of being blocked forever.
        await deleteScheduledTask(deps.schedule, record.scheduleId, record.sessionId, log);
        await removeState(stateFile);
      } else {
        return fail(
          'reboot_already_pending',
          `已经有一个重启续跑请求在等待执行（计划任务 ${record.scheduleId}）。请等待它完成，或先取消该计划任务并删除 ${stateFile}。`,
        );
      }
    }
  }

  const preflight = await probeRebootPermission(config);
  if (parsed.dryRun) {
    if (!preflight.ok) {
      return {
        ok: false,
        dryRun: true,
        code: 'reboot_not_authorized',
        message: preflight.detail,
        canReboot: preflight.canReboot,
        rebootCommand: config.rebootCommand.join(' '),
        approvalRequired: !config.allowUnattended,
        unattendedAllowed: config.allowUnattended,
      };
    }
    return {
      ok: true,
      dryRun: true,
      code: 'reboot_authorized',
      message:
        `重启权限检查通过（${preflight.method}）。正式调用会在 ${config.rebootDelaySeconds} 秒后重启，`
        + `并在约 ${config.rebootDelaySeconds + config.fallbackDelaySeconds} 秒后由计划任务兜底交付续跑。`,
      canReboot: preflight.canReboot,
      rebootCommand: config.rebootCommand.join(' '),
      rebootInSeconds: config.rebootDelaySeconds,
      fallbackInSeconds: config.rebootDelaySeconds + config.fallbackDelaySeconds,
      bootIdAvailable: bootId !== null,
      approvalRequired: !config.allowUnattended,
      unattendedAllowed: config.allowUnattended,
      sessionId: callerSessionId,
      targetSessionId,
    };
  }
  if (!preflight.ok) {
    return fail('reboot_not_authorized', preflight.detail, {
      canReboot: preflight.canReboot,
      rebootCommand: config.rebootCommand.join(' '),
    });
  }

  let approvalState = 'skipped';
  if (!config.allowUnattended) {
    const approval = ctx.get('approval');
    if (approval === undefined || typeof approval.request !== 'function') {
      return fail('approval_unavailable', '当前运行环境没有可用的审批通道，未重启。');
    }

    const shortReason = truncate(reasonForDisplay(parsed.reason), MAX_APPROVAL_REASON);
    const targetNote = targetSessionId === callerSessionId
      ? ''
      : `\n\nContinuation target session: ${targetSessionId}`;
    const targetNoteZh = targetSessionId === callerSessionId
      ? ''
      : `\n\n续跑目标会话：${targetSessionId}`;
    const approvalRequest = {
      agent,
      toolName: TOOL_NAME,
      callId: exec.callId,
      reason: `system_reboot: ${shortReason}`,
      displayReason: {
        en:
          `Restart this computer in ${config.rebootDelaySeconds} seconds and continue this chat automatically after `
          + `DeepSeek Harness starts again.\n\nReason: ${shortReason}\n\nAll running applications will be interrupted. `
          + 'Save other work first.' + targetNote,
        zh:
          `将在 ${config.rebootDelaySeconds} 秒后重启电脑，并在 DeepSeek Harness 重新启动后自动继续本会话。\n\n`
          + `原因：${shortReason}\n\n所有正在运行的程序都会被中断，请先保存其他工作。` + targetNoteZh,
      },
    };
    if (exec.signal !== undefined) approvalRequest.signal = exec.signal;

    let outcome;
    try {
      outcome = await approval.request(approvalRequest);
    } catch (error) {
      if (exec.signal?.aborted) return fail('approval_cancelled', '重启请求已取消，未重启。');
      log.warn(`approval request failed: ${safeErrorMessage(error)}`);
      return fail('approval_failed', '审批请求失败，未重启。');
    }
    if (outcome !== 'allowed-once') {
      const message = outcome === 'rejected'
        ? '审批未通过（可能是当前会话的 never 策略，或用户拒绝），未重启。'
        : outcome === 'cancelled'
          ? '重启请求已取消，未重启。'
          : '没有获得重启许可，未重启。';
      return fail(`approval_${String(outcome)}`, message);
    }
    approvalState = 'allowed-once';
  } else {
    log.warn('unattended reboot: approval skipped by profile config');
  }
  if (exec.signal?.aborted) return fail('cancelled', '重启请求在安排前被取消，未重启。');

  const continuationId = randomUUID();
  let entry;
  try {
    entry = await deps.schedule.create(
      {
        title: buildScheduleTitle(parsed.reason),
        prompt: buildResumePrompt({
          continuationId,
          reason: parsed.reason,
          custom: parsed.resumePrompt,
        }),
        timing: {
          kind: 'after',
          after_seconds: config.rebootDelaySeconds + config.fallbackDelaySeconds,
        },
        target: { kind: 'session', sessionId: targetSessionId },
      },
      callerSessionId,
      exec.signal,
    );
  } catch (error) {
    if (String(error?.code ?? '') === 'subagent_session') {
      return fail('subagent_session', '子代理不能安排自动续跑；请在主会话中执行。');
    }
    log.warn(`could not create the continuation task: ${safeErrorMessage(error)}`);
    return fail('schedule_failed', '无法创建自动续跑任务，未重启。请检查计划任务功能是否可用。');
  }

  await recordEvent(config, {
    event: 'scheduled',
    scheduleId: String(entry.id),
    callerSessionId: String(callerSessionId),
    targetSessionId: String(targetSessionId),
    scheduledAt: entry.scheduledAt ?? null,
  });

  const record = {
    version: STATE_VERSION,
    continuationId,
    scheduleId: entry.id,
    sessionId: targetSessionId,
    bootId,
    createdAt: new Date().toISOString(),
    reason: truncate(parsed.reason, MAX_REASON),
  };
  try {
    await createPending(stateFile, record);
  } catch (error) {
    await deleteScheduledTask(deps.schedule, entry.id, callerSessionId, log);
    if (String(error?.code ?? '') === 'EEXIST') {
      return fail('reboot_already_pending', '另一个重启请求已排入队列；本次未重启。');
    }
    await removeState(stateFile).catch(() => {});
    log.warn(`could not persist reboot state: ${safeErrorMessage(error)}`);
    return fail('state_write_failed', '无法保存自动续跑状态，未重启。');
  }

  await recordEvent(config, { event: 'state-written', scheduleId: String(entry.id) });

  try {
    await fs.access('/bin/sh', fsConstants.X_OK);
    await recordEvent(config, {
      event: 'reboot-spawned',
      scheduleId: String(entry.id),
      delaySeconds: config.rebootDelaySeconds,
    });
    spawnReboot(config, log);
  } catch (error) {
    await deleteScheduledTask(deps.schedule, entry.id, callerSessionId, log);
    await removeState(stateFile).catch(() => {});
    log.warn(`could not launch the reboot: ${safeErrorMessage(error)}`);
    return fail('reboot_spawn_failed', '无法启动重启命令，未重启。');
  }

  // The reboot starts after a short delay. Close the turn now so the tool
  // result and the closed turn reach durable storage before systemd stops us.
  try {
    exec.concludeTurn?.();
  } catch {
    // A turn that cannot be concluded still has the durable continuation.
  }

  return {
    ok: true,
    code: 'reboot_scheduled',
    message:
      `${approvalState === 'skipped' ? '本 profile 已允许无人值守重启，本次调用跳过审批。' : ''}`
      + `将在 ${config.rebootDelaySeconds} 秒后重启。自动续跑已排入本会话（计划任务 ${entry.id}）；`
      + `DSH 重新启动后会自动继续，若启动钩子不可用，计划任务会在约 `
      + `${config.rebootDelaySeconds + config.fallbackDelaySeconds} 秒时兜底交付。`,
    approval: approvalState,
    continuationId,
    scheduleId: entry.id,
    ...(entry.scheduledAt === undefined ? {} : { scheduledAt: entry.scheduledAt }),
    sessionId: callerSessionId,
    targetSessionId,
    rebootInSeconds: config.rebootDelaySeconds,
    fallbackInSeconds: config.rebootDelaySeconds + config.fallbackDelaySeconds,
    bootIdAvailable: bootId !== null,
  };
}

/**
 * Resolve Xiaomi account credentials from configuration, the environment, or
 * the DSH credential store, in that order.
 * @param ctx - Plugin scope that may expose the credential store.
 * @param coldBoot - Normalized cold-boot config.
 * @returns Username and password (either may be empty).
 */
async function resolveAccount(ctx, coldBoot) {
  let username = coldBoot.account.username;
  let password = coldBoot.account.password;
  if (username === '') username = process.env.XIAOMI_USERNAME ?? '';
  if (password === '') password = process.env.XIAOMI_PASSWORD ?? '';
  if (username !== '' && password !== '') return { username, password };

  const store = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
  if (store === undefined || typeof store.readRecord !== 'function') return { username, password };
  try {
    const record = await store.readRecord('reboot-resume/xiaomi-account');
    const payload = record?.payload ?? {};
    if (username === '' && typeof payload.username === 'string') username = payload.username;
    if (password === '' && typeof payload.password === 'string') password = payload.password;
  } catch {
    // A credential store that cannot answer simply leaves the values empty.
  }
  return { username, password };
}

/**
 * Describe one plug for tool output without leaking its token.
 * @param plug - Resolved plug descriptor.
 * @returns Safe descriptor.
 */
function publicPlug(plug) {
  return {
    host: plug.host,
    did: plug.did,
    name: plug.name,
    model: plug.model,
    source: plug.source,
    tokenConfigured: plug.token !== '',
  };
}

/**
 * Undo the durable parts of a cold boot that never reached the power cut.
 * @param deps - Plugin dependencies.
 * @param scheduleId - Continuation task to delete.
 * @param callerSessionId - Acting session.
 */
async function rollbackColdBoot(deps, scheduleId, callerSessionId) {
  if (scheduleId !== undefined && scheduleId !== null) {
    await deleteScheduledTask(deps.schedule, scheduleId, callerSessionId, deps.log);
  }
  await removeState(deps.stateFile).catch(() => {});
}

/**
 * Cold boot: arm the continuation, arm the out-of-band power-on path, then cut
 * mains power through the plug.
 *
 * Ordering is the safety property. Nothing is powered off until the
 * continuation is durable and the restore command has succeeded, because the
 * machine cannot turn its own power back on.
 *
 * @param ctx - Schedule-resolved plugin scope.
 * @param rawArgs - Unvalidated model arguments.
 * @param exec - Tool execution identity and caller agent.
 * @param deps - Resolved config, state path, and logger.
 * @returns The canonical tool value.
 */
async function runColdBoot(ctx, rawArgs, exec, deps) {
  const { config, stateFile, log } = deps;
  const base = config.coldBoot;
  const parsed = parseArgs(rawArgs, { coldBoot: true });
  if (parsed.kind === 'error') return fail('invalid_arguments', parsed.message);
  if (!base.enabled) {
    return fail('cold_boot_disabled', '冷启动未启用：请在配置里设置 coldBoot.enabled = true。');
  }
  // Per-call overrides win over the profile values, clamped to safe ranges.
  const coldBoot = { ...base, ...effectiveTimings(base, parsed.timings) };

  const agent = exec.agent;
  if (agent === undefined) return fail('no_agent', '冷启动工具需要一个活动的会话。');
  if (delegationDepth(agent) > 0) {
    return fail('subagent_session', '子代理不能冷启动电脑；请在主会话中执行。');
  }
  const callerSessionId = agent.session.id;
  const targetSessionId = parsed.targetSession === '' ? callerSessionId : parsed.targetSession;

  let state = await inspectState(stateFile);
  if (state.kind === 'corrupt') {
    const cleared = await clearIfStaleCorrupt(stateFile, config, log);
    if (!cleared) {
      return fail('reboot_state_unreadable', `续跑状态文件无法解析：${stateFile}。请检查或删除该文件后重试。`);
    }
    state = { kind: 'none' };
  }
  if (state.kind === 'pending' && state.record.resumedAt === undefined) {
    return fail(
      'cold_boot_already_pending',
      `已经有一个续跑请求在等待执行（计划任务 ${state.record.scheduleId}）。请等待它完成，或先取消该计划任务并删除 ${stateFile}。`,
    );
  }
  if (state.kind === 'pending' && state.record.resumedAt !== undefined) {
    await removeState(stateFile);
  }

  const account = await resolveAccount(ctx, coldBoot);
  let plug;
  let status = null;
  let plugError = '';
  try {
    plug = await resolvePlug({
      config: coldBoot,
      cacheFile: coldBoot.cacheFile,
      log,
      credentials: account,
    });
    status = await plugStatus(plug);
  } catch (error) {
    plugError = safeErrorMessage(error);
    log.warn(`cold boot plug resolution failed: ${plugError}`);
  }

  // A moved DHCP address is the common failure: when an account is available,
  // re-read the cloud device list once and retry.
  if (status === null && account.username !== '' && account.password !== '') {
    try {
      plug = await resolvePlug({
        config: coldBoot,
        cacheFile: coldBoot.cacheFile,
        log,
        credentials: account,
        forceRefresh: true,
      });
      status = await plugStatus(plug);
      plugError = '';
    } catch (error) {
      plugError = safeErrorMessage(error);
    }
  }

  const plan = planColdBoot({ coldBoot, plugStatus: status });
  if (plugError !== '' && status === null) {
    plan.blockers.unshift(`插座不可达：${plugError}`);
    plan.ok = false;
  }

  // Jump-host mode needs two things verified while the machine is still up:
  // a usable cloud session for the pre-signed request, and SSH reachability
  // plus the tools that send it. Both are read-only checks.
  let jumpSession = null;
  if (coldBoot.restore.mode === 'jump' && coldBoot.restore.jump.host !== '') {
    const cache = await readCache(coldBoot.cacheFile);
    jumpSession = cache?.session ?? null;
    if (jumpSession === null) {
      plan.blockers.push('跳板机模式需要小米云端会话：请先运行 tools/probe.mjs session 缓存会话（上电请求要用它签名）。');
    } else if (plug !== undefined && plug.did !== '') {
      try {
        await cloudGetProperty({
          session: jumpSession,
          did: plug.did,
          siid: plug.switchSpec.siid,
          piid: plug.switchSpec.piid,
        });
      } catch (error) {
        plan.blockers.push(`小米云端会话不可用：${safeErrorMessage(error)}`);
      }
    } else {
      plan.blockers.push('跳板机模式需要插座的 did（云端设备 id），当前插座信息里没有。');
    }
    const jumpPreflight = await preflightJump({
      host: coldBoot.restore.jump.host,
      identity: coldBoot.restore.jump.identity,
      sshOptions: coldBoot.restore.jump.sshOptions,
      execFileImpl: execFile,
    });
    if (!jumpPreflight.ok) plan.blockers.push(jumpPreflight.detail);
    else plan.steps.push(jumpPreflight.detail);
  }
  if (plan.blockers.length === 0) {
    const haltPreflight = await probePowerPermission(coldBoot.haltCommand, 'poweroff');
    if (!haltPreflight.ok) plan.blockers.push(haltPreflight.detail);
    else plan.steps.push(haltPreflight.detail);
  }
  plan.ok = plan.blockers.length === 0;

  if (parsed.dryRun) {
    return {
      ok: plan.ok,
      dryRun: true,
      code: plan.ok ? 'cold_boot_ready' : 'cold_boot_blocked',
      message: plan.ok
        ? `冷启动前置检查通过：插座 ${plug.host} 当前为 ${status.power}，恢复方式 ${coldBoot.restore.mode}；`
          + `时序 关机缓冲 ${coldBoot.shutdownGraceSeconds}s / 关机后 ${coldBoot.powerCutDelaySeconds}s 断电 / `
          + `断电 ${coldBoot.outageSeconds}s 后上电（约 ${coldBoot.shutdownGraceSeconds + coldBoot.powerCutDelaySeconds + coldBoot.outageSeconds}s 后上电）。`
        : `冷启动前置检查未通过：${plan.blockers.join(' ')}`,
      plug: plug === undefined ? null : publicPlug(plug),
      status,
      plan,
      restoreMode: coldBoot.restore.mode,
      timings: {
        shutdownGraceSeconds: coldBoot.shutdownGraceSeconds,
        powerCutDelaySeconds: coldBoot.powerCutDelaySeconds,
        outageSeconds: coldBoot.outageSeconds,
      },
      approvalRequired: !config.allowUnattended,
      sessionId: callerSessionId,
      targetSessionId,
    };
  }

  if (!plan.ok) {
    return fail('cold_boot_blocked', `冷启动被拒绝：${plan.blockers.join(' ')}`, { plan });
  }

  let approvalState = 'skipped';
  if (!config.allowUnattended) {
    const approval = ctx.get('approval');
    if (approval === undefined || typeof approval.request !== 'function') {
      return fail('approval_unavailable', '当前运行环境没有可用的审批通道，未冷启动。');
    }
    const shortReason = truncate(reasonForDisplay(parsed.reason), MAX_APPROVAL_REASON);
    const approvalRequest = {
      agent,
      toolName: COLD_BOOT_TOOL_NAME,
      callId: exec.callId,
      reason: `system_cold_boot: ${shortReason}`,
      displayReason: {
        en:
          `Shut this computer down cleanly, cut mains power after ${coldBoot.powerCutDelaySeconds}s, `
          + `restore power ${coldBoot.outageSeconds}s later, and continue this chat after it boots again.`
          + `\n\nReason: ${shortReason}`
          + `\n\nAll running applications will be closed now. The computer cannot power itself back on; `
          + `restore mode is "${coldBoot.restore.mode}".`,
        zh:
          `先干净关机，${coldBoot.powerCutDelaySeconds} 秒后通过智能插座切断市电，`
          + `${coldBoot.outageSeconds} 秒后重新上电，等电脑重启后自动继续本会话。`
          + `\n\n原因：${shortReason}`
          + `\n\n现在开始关闭所有正在运行的程序。电脑无法自行上电，恢复方式为“${coldBoot.restore.mode}”。`,
      },
    };
    if (exec.signal !== undefined) approvalRequest.signal = exec.signal;
    let outcome;
    try {
      outcome = await approval.request(approvalRequest);
    } catch (error) {
      if (exec.signal?.aborted) return fail('approval_cancelled', '冷启动请求已取消，未断电。');
      log.warn(`approval request failed: ${safeErrorMessage(error)}`);
      return fail('approval_failed', '审批请求失败，未断电。');
    }
    if (outcome !== 'allowed-once') {
      return fail(`approval_${String(outcome)}`, '没有获得冷启动许可，未断电。');
    }
    approvalState = 'allowed-once';
  }

  const continuationId = randomUUID();
  const fallbackSeconds = coldBoot.shutdownGraceSeconds
    + coldBoot.powerCutDelaySeconds
    + coldBoot.outageSeconds
    + config.fallbackDelaySeconds;
  let entry;
  try {
    entry = await deps.schedule.create(
      {
        title: buildScheduleTitle(parsed.reason, '冷启动续跑'),
        prompt: buildResumePrompt({
          continuationId,
          reason: parsed.reason,
          custom: parsed.resumePrompt,
          tool: COLD_BOOT_TOOL_NAME,
        }),
        timing: { kind: 'after', after_seconds: fallbackSeconds },
        target: { kind: 'session', sessionId: targetSessionId },
      },
      callerSessionId,
      exec.signal,
    );
  } catch (error) {
    log.warn(`could not create the cold-boot continuation task: ${safeErrorMessage(error)}`);
    return fail('schedule_failed', '无法创建自动续跑任务，未断电。');
  }

  const bootId = await readBootId();
  const record = {
    version: STATE_VERSION,
    kind: 'cold-boot',
    continuationId,
    scheduleId: entry.id,
    sessionId: targetSessionId,
    bootId,
    createdAt: new Date().toISOString(),
    reason: truncate(parsed.reason, MAX_REASON),
    plug: publicPlug(plug),
    restoreMode: coldBoot.restore.mode,
    powerCutDelaySeconds: coldBoot.powerCutDelaySeconds,
    outageSeconds: coldBoot.outageSeconds,
  };
  try {
    await createPending(stateFile, record);
  } catch (error) {
    await rollbackColdBoot(deps, entry.id, callerSessionId);
    if (String(error?.code ?? '') === 'EEXIST') {
      return fail('cold_boot_already_pending', '另一个续跑请求已排入队列；本次未断电。');
    }
    log.warn(`could not persist cold-boot state: ${safeErrorMessage(error)}`);
    return fail('state_write_failed', '无法保存自动续跑状态，未断电。');
  }
  await recordEvent(config, {
    event: 'cold-boot-armed',
    scheduleId: String(entry.id),
    targetSessionId: String(targetSessionId),
    plugHost: plug.host,
    restoreMode: coldBoot.restore.mode,
  });

  // Arm the out-of-band power cycle before the machine loses the ability to
  // act at all: the jump host must cut power after the shutdown and restore it
  // after the discharge. A failure here aborts while the machine is still up.
  if (coldBoot.restore.mode === 'jump') {
    let armed;
    try {
      const common = {
        session: jumpSession,
        did: plug.did,
        siid: plug.switchSpec.siid,
        piid: plug.switchSpec.piid,
        apiHost: coldBoot.restore.jump.apiHost,
      };
      const offRequest = buildPowerRequest({ ...common, value: false });
      const onRequest = buildPowerRequest({ ...common, value: true });
      armed = await armJumpRestore({
        host: coldBoot.restore.jump.host,
        identity: coldBoot.restore.jump.identity,
        sshOptions: coldBoot.restore.jump.sshOptions,
        offRequestBase64: offRequest.base64,
        onRequestBase64: onRequest.base64,
        powerCutDelaySeconds: coldBoot.powerCutDelaySeconds,
        outageSeconds: coldBoot.outageSeconds,
        shutdownGraceSeconds: coldBoot.shutdownGraceSeconds,
        apiHost: coldBoot.restore.jump.apiHost,
        execFileImpl: execFile,
      });
      await recordEvent(config, {
        event: 'cold-boot-jump-armed',
        ok: armed.ok,
        host: coldBoot.restore.jump.host,
        powerCutInSeconds: coldBoot.powerCutDelaySeconds + coldBoot.shutdownGraceSeconds,
        powerOnInSeconds: coldBoot.powerCutDelaySeconds + coldBoot.shutdownGraceSeconds + coldBoot.outageSeconds,
        offRequestBytes: offRequest.bytes,
        onRequestBytes: onRequest.bytes,
      });
    } catch (error) {
      armed = { ok: false, detail: safeErrorMessage(error) };
    }
    if (!armed.ok) {
      await rollbackColdBoot(deps, entry.id, callerSessionId);
      return fail(
        'restore_failed',
        `无法把断电/上电请求交给跳板机，已在关机前中止：${truncate(armed.detail ?? '', 300)}`,
      );
    }
  } else if (coldBoot.restore.mode === 'command') {
    const restore = await runRestoreCommand({
      command: coldBoot.restore.command,
      timeoutMs: 15000,
      execFile,
      log,
    });
    await recordEvent(config, {
      event: 'cold-boot-restore-armed',
      ok: restore.ok,
      detail: truncate(restore.detail ?? '', 400),
    });
    if (!restore.ok) {
      await rollbackColdBoot(deps, entry.id, callerSessionId);
      return fail(
        'restore_failed',
        `外部恢复命令执行失败，已在关机前中止：${truncate(restore.detail ?? '', 300)}`,
      );
    }
  } else {
    log.warn('cold boot with manual restore: the user must power the plug back on');
  }

  if (exec.signal?.aborted) {
    await rollbackColdBoot(deps, entry.id, callerSessionId);
    return fail('cancelled', '冷启动请求在关机前被取消。');
  }

  // Clean shutdown first; the jump host cuts power later. This avoids a hard
  // power cut while the kernel is still writing.
  try {
    await fs.access('/bin/sh', fsConstants.X_OK);
    await recordEvent(config, {
      event: 'cold-boot-halt-spawned',
      scheduleId: String(entry.id),
      command: coldBoot.haltCommand.join(' '),
      graceSeconds: coldBoot.shutdownGraceSeconds,
    });
    (deps.spawnHalt ?? spawnHalt)(coldBoot, log);
  } catch (error) {
    await rollbackColdBoot(deps, entry.id, callerSessionId);
    log.warn(`could not launch the shutdown: ${safeErrorMessage(error)}`);
    return fail('halt_spawn_failed', '无法启动关机命令，未关机；跳板机上的断电/上电计划仍会执行，请手动取消或等待。');
  }

  try {
    exec.concludeTurn?.();
  } catch {
    // The durable continuation is already stored; a failed close is not fatal.
  }

  return {
    ok: true,
    code: 'cold_boot_started',
    message:
      `${approvalState === 'skipped' ? '本 profile 已允许无人值守操作，本次跳过审批。' : ''}`
      + `正在关机；跳板机会在约 ${coldBoot.powerCutDelaySeconds + coldBoot.shutdownGraceSeconds} 秒后断电，`
      + `${coldBoot.powerCutDelaySeconds + coldBoot.shutdownGraceSeconds + coldBoot.outageSeconds} 秒后上电。`
      + `自动续跑已排入本会话；DSH 启动后会按 boot id 立即续跑，`
      + `兜底计划任务在约 ${fallbackSeconds} 秒时交付。`,
    approval: approvalState,
    plug: publicPlug(plug),
    status,
    plan,
    restoreMode: coldBoot.restore.mode,
    continuationId,
    scheduleId: entry.id,
    sessionId: callerSessionId,
    targetSessionId,
    timings: {
      shutdownGraceSeconds: coldBoot.shutdownGraceSeconds,
      powerCutDelaySeconds: coldBoot.powerCutDelaySeconds,
      outageSeconds: coldBoot.outageSeconds,
    },
    powerCutInSeconds: coldBoot.powerCutDelaySeconds + coldBoot.shutdownGraceSeconds,
    powerOnInSeconds: coldBoot.powerCutDelaySeconds + coldBoot.shutdownGraceSeconds + coldBoot.outageSeconds,
    fallbackInSeconds: fallbackSeconds,
  };
}

/**
 * Deliver a recorded continuation after a new boot.
 * @param ctx - Schedule-resolved plugin scope.
 * @param deps - Resolved config, state path, and logger.
 */
async function resumeAfterBoot(schedule, deps) {  const { config, stateFile, log } = deps;
  const state = await inspectState(stateFile);
  if (state.kind === 'none') return;
  if (state.kind === 'corrupt') {
    const cleared = await clearIfStaleCorrupt(stateFile, config, log);
    if (!cleared) log.warn(`unreadable reboot state at ${stateFile}; the scheduled fallback still applies`);
    return;
  }

  const record = state.record;
  if (record.version !== STATE_VERSION) {
    log.warn(`unknown reboot state version ${String(record.version)}; leaving it in place`);
    return;
  }
  if (record.resumedAt !== undefined) {
    await recordEvent(config, {
      event: 'startup-skip',
      scheduleId: String(record.scheduleId),
      reason: 'resumed-at',
    });
    await removeState(stateFile);
    return;
  }

  const currentBootId = await readBootId();
  const sameBoot = record.bootId !== null && currentBootId !== null && record.bootId === currentBootId;
  const age = Date.now() - Date.parse(record.createdAt);
  await recordEvent(config, {
    event: 'startup-check',
    scheduleId: String(record.scheduleId),
    targetSessionId: String(record.sessionId),
    sameBoot,
    bootIdAvailable: record.bootId !== null && currentBootId !== null,
  });

  if (sameBoot) {
    if (Number.isFinite(age) && age > config.staleMs) {
      log.info(`clearing stale reboot continuation ${record.scheduleId}`);
      await recordEvent(config, {
        event: 'startup-skip',
        scheduleId: String(record.scheduleId),
        reason: 'stale-same-boot',
      });
      await deleteScheduledTask(deps.schedule, record.scheduleId, record.sessionId, log);
      await removeState(stateFile);
    }
    return;
  }
  if (record.bootId === null || currentBootId === null) {
    // Without both boot ids we cannot prove a reboot happened; the durable
    // Schedule task remains the safe fallback.
    await recordEvent(config, {
      event: 'startup-skip',
      scheduleId: String(record.scheduleId),
      reason: 'boot-id-unavailable',
    });
    log.info('boot id unavailable; waiting for the scheduled continuation');
    return;
  }

  await recordEvent(config, {
    event: 'new-boot',
    scheduleId: String(record.scheduleId),
    targetSessionId: String(record.sessionId),
  });
  log.info(`new boot detected; delivering continuation ${record.scheduleId}`);
  await deliverContinuation(schedule, record, deps);
}

/**
 * Run the Schedule task immediately, then remove it so it cannot fire twice.
 * @param ctx - Schedule-resolved plugin scope.
 * @param record - Validated pending record.
 * @param deps - Resolved config, state path, and logger.
 */
async function deliverContinuation(schedule, record, deps) {
  const { config, stateFile, log } = deps;
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const view = await schedule.view({ id: record.scheduleId });
      await recordEvent(config, {
        event: 'continuation-view',
        scheduleId: String(record.scheduleId),
        attempt,
        code: view?.code ?? null,
        status: view?.status ?? null,
      });
      if (view === undefined || view.code === 'schedule_not_found') {
        if (attempt < attempts) {
          log.info(`continuation ${record.scheduleId} not loaded yet; retrying`);
          await sleep(attempt * 2000);
          continue;
        }
        log.warn(`continuation ${record.scheduleId} is missing after ${attempts} checks`);
        await markResumed(stateFile, record, log, 'schedule-not-found');
        return;
      }
      if (view.status === 'paused') {
        log.info(`scheduled continuation ${record.scheduleId} is paused; respecting it`);
        await markResumed(stateFile, record, log, 'task-paused');
        return;
      }
      if (view.status === 'ended') {
        log.info(`scheduled continuation ${record.scheduleId} already ended`);
        await markResumed(stateFile, record, log, 'task-ended');
        return;
      }

      const runResult = await schedule.run({ id: record.scheduleId });
      await recordEvent(config, {
        event: 'continuation-run',
        scheduleId: String(record.scheduleId),
        attempt,
        code: runResult?.code ?? null,
        status: runResult?.status ?? null,
      });
      if (runResult !== undefined && runResult.code === 'schedule_execution_pending') {
        log.info(`continuation ${record.scheduleId} is already being delivered`);
        await markResumed(stateFile, record, log, 'execution-pending');
        return;
      }
      if (runResult !== undefined && runResult.code === 'schedule_not_found') {
        if (attempt < attempts) {
          await sleep(attempt * 2000);
          continue;
        }
        await markResumed(stateFile, record, log, 'run-not-found');
        return;
      }

      await deleteScheduledTask(deps.schedule, record.scheduleId, record.sessionId, log);
      await markResumed(stateFile, record, log, 'delivered');
      await recordEvent(config, {
        event: 'continuation-delivered',
        scheduleId: String(record.scheduleId),
        targetSessionId: String(record.sessionId),
      });
      log.info(`continuation ${record.scheduleId} delivered`);
      return;
    } catch (error) {
      const code = String(error?.code ?? '');
      await recordEvent(config, {
        event: 'continuation-error',
        scheduleId: String(record.scheduleId),
        attempt,
        code,
        message: safeErrorMessage(error),
      });
      if (code === 'schedule/target-archived') {
        log.warn('continuation target is archived; unarchive the session and restart DSH to retry');
        return;
      }
      if (attempt < attempts) {
        await sleep(attempt * 2000);
        continue;
      }
      log.warn(`could not deliver continuation ${record.scheduleId}: ${safeErrorMessage(error)}; the scheduled fallback remains`);
      return;
    }
  }
}

/**
 * Write the pending record without overwriting another request.
 * @param stateFile - Absolute path of `pending.json`.
 * @param record - Record to persist.
 */
async function createPending(stateFile, record) {
  const directory = path.dirname(stateFile);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => {});
  const handle = await fs.open(stateFile, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await handle.sync().catch(() => {});
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Append one diagnostic event without ever affecting reboot delivery.
 * @param config - Resolved config carrying `pendingDir`.
 * @param event - Small lossless event record.
 */
async function recordEvent(config, event) {
  try {
    await fs.mkdir(config.pendingDir, { recursive: true, mode: 0o700 });
    await fs.appendFile(
      path.join(config.pendingDir, 'events.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Diagnostics are best effort.
  }
}

/**
 * Mark a record as delivered before removing it, so a crash between the two
 * steps cannot replay the continuation on the next start.
 * @param stateFile - Absolute path of `pending.json`.
 * @param record - Delivered record.
 * @param log - Plugin logger.
 */
async function markResumed(stateFile, record, log, reason = 'resumed') {
  await recordEvent(
    { pendingDir: path.dirname(stateFile) },
    {
      event: 'state-cleared',
      scheduleId: String(record.scheduleId),
      targetSessionId: String(record.sessionId),
      reason,
    },
  );
  try {
    await fs.writeFile(
      stateFile,
      `${JSON.stringify({ ...record, resumedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    log.warn(`could not mark the continuation as delivered: ${safeErrorMessage(error)}`);
  }
  await removeState(stateFile).catch((error) => {
    log.warn(`could not remove the pending state: ${safeErrorMessage(error)}`);
  });
}

/**
 * Remove a pending state file, treating absence as success.
 * @param stateFile - Absolute path of `pending.json`.
 */
async function removeState(stateFile) {
  try {
    await fs.unlink(stateFile);
  } catch (error) {
    if (String(error?.code ?? '') !== 'ENOENT') throw error;
  }
}

/**
 * Read and validate the pending record.
 * @param stateFile - Absolute path of `pending.json`.
 * @returns `none`, `corrupt`, or a validated `pending` record.
 */
async function inspectState(stateFile) {
  let text;
  try {
    text = await fs.readFile(stateFile, 'utf8');
  } catch (error) {
    if (String(error?.code ?? '') === 'ENOENT') return { kind: 'none' };
    throw error;
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!isValidRecord(record)) return { kind: 'corrupt' };
  return { kind: 'pending', record };
}

/**
 * Validate the shape of a pending record without trusting it.
 * @param record - Parsed JSON value.
 * @returns Whether the value is a record this plugin can act on.
 */
function isValidRecord(record) {
  return record !== null
    && typeof record === 'object'
    && !Array.isArray(record)
    && typeof record.scheduleId === 'string'
    && record.scheduleId !== ''
    && typeof record.sessionId === 'string'
    && record.sessionId !== ''
    && typeof record.createdAt === 'string'
    && Number.isFinite(Date.parse(record.createdAt));
}

/**
 * Quarantine a corrupt record once it is old enough that it cannot be a live
 * request; a fresh corrupt file blocks new reboots rather than being deleted.
 * @param stateFile - Absolute path of `pending.json`.
 * @param config - Resolved config.
 * @param log - Plugin logger.
 * @returns Whether the caller may continue as if no record existed.
 */
async function clearIfStaleCorrupt(stateFile, config, log) {
  const stat = await fs.stat(stateFile).catch(() => null);
  if (stat === null) return true;
  if (Date.now() - stat.mtimeMs <= config.staleMs) return false;
  const target = `${stateFile}.corrupt-${Date.now()}`;
  try {
    await fs.rename(stateFile, target);
    log.warn(`moved unreadable reboot state to ${target}`);
    return true;
  } catch (error) {
    log.warn(`could not quarantine unreadable reboot state: ${safeErrorMessage(error)}`);
    return false;
  }
}

/**
 * Delete a scheduled continuation, falling back to pausing it so it cannot
 * deliver a duplicate prompt if deletion is refused.
 * @param ctx - Schedule-resolved plugin scope.
 * @param scheduleId - Task to remove.
 * @param sessionId - Acting/target session.
 * @param log - Plugin logger.
 */
async function deleteScheduledTask(schedule, scheduleId, sessionId, log) {
  try {
    const result = await schedule.edit({ id: scheduleId, action: 'delete' }, sessionId);
    if (result !== undefined && result.code === 'schedule_not_found') return;
  } catch (error) {
    log?.warn?.(`could not delete continuation ${scheduleId}: ${safeErrorMessage(error)}`);
    try {
      await schedule.edit(
        { id: scheduleId, action: 'update', patch: { active: false } },
        sessionId,
      );
    } catch (pauseError) {
      log?.warn?.(`could not pause continuation ${scheduleId}: ${safeErrorMessage(pauseError)}`);
    }
  }
}

/**
 * Read the kernel boot id. It changes on every boot and is shared by the Host
 * and its subprocesses, which makes it a cheap reboot detector.
 * @returns The boot id, or null when unavailable.
 */
async function readBootId() {
  try {
    const value = await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8');
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Verify that the configured reboot command is likely to run without an
 * interactive authentication prompt.
 * @param config - Resolved config.
 * @returns Permission probe result.
 */
async function probeRebootPermission(config) {
  return probePowerPermission(config.rebootCommand, 'reboot');
}

/**
 * Verify that a power action can run without an interactive prompt.
 * @param command - Configured argv (`systemctl reboot`, `systemctl poweroff`, or sudo).
 * @param action - `reboot` or `poweroff`; selects the PolicyKit question.
 * @returns Permission probe result.
 */
async function probePowerPermission(command, action) {
  const label = action === 'poweroff' ? '关机' : '重启';
  if (process.platform !== 'linux') {
    return {
      ok: false,
      method: 'unsupported',
      canReboot: 'unsupported',
      detail: `system_${action === 'poweroff' ? 'cold_boot' : 'reboot'} 目前只支持 Linux + systemd。`,
    };
  }

  const executable = command[0];
  if (executable === 'sudo') {
    const probe = await runCommand('sudo', ['-n', 'true'], 5000);
    if (probe.exitCode === 0 && probe.errorCode === undefined) {
      return { ok: true, method: 'sudo', canReboot: 'yes', detail: 'sudo -n 可用。' };
    }
    return {
      ok: false,
      method: 'sudo',
      canReboot: 'sudo-denied',
      detail: 'sudo -n 不可用。请配置 NOPASSWD，或改用默认的 systemctl 命令并配置 polkit 规则。',
    };
  }

  const busArgs = [
    'call',
    'org.freedesktop.login1',
    '/org/freedesktop/login1',
    'org.freedesktop.login1.Manager',
    action === 'poweroff' ? 'CanPowerOff' : 'CanReboot',
  ];
  let probe = await runCommand('busctl', busArgs, 5000);
  if (probe.errorCode === 'ENOENT') {
    probe = await runCommand('/usr/bin/busctl', busArgs, 5000);
  }
  if (probe.errorCode !== undefined || probe.exitCode !== 0) {
    const detail = truncate(
      probe.stderr.trim() !== '' ? probe.stderr.trim() : (probe.message || '无法查询 systemd-logind。'),
      300,
    );
    return { ok: false, method: 'busctl', canReboot: 'unknown', detail: `无法查询${label}权限：${detail}` };
  }
  const match = /s\s+"(yes|no|challenge|na)"/.exec(probe.stdout);
  const answer = match?.[1];
  if (answer === 'yes') {
    return {
      ok: true,
      method: 'polkit',
      canReboot: 'yes',
      detail: `PolicyKit 允许此进程无需交互即可${label}。`,
    };
  }
  if (answer === 'challenge') {
    return {
      ok: false,
      method: 'polkit',
      canReboot: 'challenge',
      detail:
        `PolicyKit 需要交互认证才能${label}（Can${action === 'poweroff' ? 'PowerOff' : 'Reboot'}=challenge）。`
        + 'DSH 以 systemd user service 运行，没有自己的 logind session，所以'
        + ' `allow_active=yes` 不适用，只能走 `auth_admin_keep`：登录后的临时授权过期后就会变成 challenge。'
        + ' 装一条 polkit 规则即可固定放行：把 docs/polkit/49-dsh-power.rules 安装到'
        + ' /etc/polkit-1/rules.d/（见 README「polkit 权限」），或用 NOPASSWD sudo 并配置'
        + " ['sudo','-n','systemctl',...] 。",
    };
  }
  return {
    ok: false,
    method: 'polkit',
    canReboot: answer ?? 'unknown',
    detail: `PolicyKit 未授权${label}（Can${action === 'poweroff' ? 'PowerOff' : 'Reboot'}=${answer ?? 'unknown'}）。`,
  };
}

/**
 * Run one helper command and normalize its outcome.
 * @param command - Executable name or absolute path.
 * @param args - Argument vector.
 * @param timeoutMs - Hard timeout.
 * @returns Exit information without throwing.
 */
function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
        windowsHide: true,
        env: process.env,
      },
      (error, stdout, stderr) => {
        const numericCode = typeof error?.code === 'number' ? error.code : error === null ? 0 : null;
        resolve({
          exitCode: numericCode,
          signal: error?.signal ?? null,
          errorCode: typeof error?.code === 'string' ? error.code : undefined,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          message: error?.message ?? '',
        });
      },
    );
  });
}

/**
 * Start the configured reboot command after the configured grace period.
 * The shell only sleeps and execs; command arguments are passed through `$@`.
 * @param config - Resolved config.
 * @param log - Plugin logger.
 */
function spawnReboot(config, log) {
  const [executable, ...args] = config.rebootCommand;
  const script = `sleep ${config.rebootDelaySeconds}; exec "$@"`;
  const child = spawn('/bin/sh', ['-c', script, 'dsh-reboot', executable, ...args], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.on('error', (error) => {
    log.warn(`reboot launcher failed: ${safeErrorMessage(error)}`);
  });
  child.unref();
}

/**
 * Invoke the shutdown command after a short grace period, so the tool result
 * and the closed turn reach durable storage before systemd stops the Host.
 * The jump host cuts mains power later; that is a separate timer.
 * @param coldBoot - Normalized cold-boot config.
 * @param log - Plugin logger.
 */
function spawnHalt(coldBoot, log) {
  // A test must never be able to power the machine off. The tests also inject
  // a harmless halt command, but this guard makes an accident impossible.
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    log.warn('refusing to spawn the shutdown command from a test process');
    return false;
  }
  const [executable, ...args] = coldBoot.haltCommand;
  const script = `sleep ${coldBoot.shutdownGraceSeconds}; exec "$@"`;
  const child = spawn('/bin/sh', ['-c', script, 'dsh-halt', executable, ...args], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.on('error', (error) => {
    log.warn(`shutdown launcher failed: ${safeErrorMessage(error)}`);
  });
  child.unref();
  return true;
}

/**
 * Build the continuation prompt stored in the Schedule task.
 * @param input - Continuation identity, reason, and optional custom prompt.
 * @returns The prompt delivered after the reboot.
 */
function buildResumePrompt({ continuationId, reason, custom, tool = TOOL_NAME }) {
  const cold = tool === COLD_BOOT_TOOL_NAME;
  const lines = [
    cold
      ? `[Automatic continuation after cold boot / 冷启动后自动续跑 ${continuationId}]`
      : `[Automatic continuation after reboot / 重启后自动续跑 ${continuationId}]`,
    cold
      ? 'The computer was power-cycled through the system_cold_boot tool (mains power was cut and restored). '
        + 'DeepSeek Harness is running again.'
      : 'The computer was restarted through the system_reboot tool. DeepSeek Harness is running again.',
    `Reboot reason: ${reason}`,
    'Continue the interrupted task from the conversation history. First verify that the reboot actually happened '
      + '(for example with `uptime`) and that the environment is healthy; then continue the remaining work.',
    `If this continuation was already handled, confirm briefly and stop. Do not call ${tool} again unless `
      + 'the user explicitly asks.',
  ];
  if (custom !== '') {
    lines.push('', 'Continuation instructions:', custom);
  }
  return lines.join('\n');
}

/**
 * Build a bounded, single-line Schedule title.
 * @param reason - Reboot reason.
 * @returns A title accepted by the Schedule service.
 */
function buildScheduleTitle(reason, prefix = '重启续跑') {
  const compact = reason.replace(/\s+/g, ' ').trim();
  const title = compact === '' ? prefix : `${prefix}：${compact}`;
  return truncate(title, MAX_TITLE);
}

/**
 * Normalize a display reason to one short line.
 * @param reason - User-supplied reason.
 * @returns A single-line summary.
 */
function reasonForDisplay(reason) {
  return reason.replace(/\s+/g, ' ').trim();
}

/**
 * Parse and validate model arguments against the declared schema.
 * @param rawArgs - Unvalidated arguments.
 * @returns A parsed value or a validation error.
 */
function parseArgs(rawArgs, options = {}) {
  if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return { kind: 'error', message: '参数必须是一个对象。' };
  }
  const allowed = new Set(['reason', 'resume_prompt', 'target_session', 'dry_run']);
  const timingFields = [
    ['shutdown_grace_seconds', 'shutdownGraceSeconds'],
    ['power_cut_delay_seconds', 'powerCutDelaySeconds'],
    ['outage_seconds', 'outageSeconds'],
  ];
  if (options.coldBoot === true) {
    for (const [field] of timingFields) allowed.add(field);
  }
  for (const key of Object.keys(rawArgs)) {
    if (!allowed.has(key)) return { kind: 'error', message: `未知参数：${key}` };
  }
  if (typeof rawArgs.reason !== 'string') {
    return { kind: 'error', message: '`reason` 必须是非空字符串。' };
  }
  const reason = rawArgs.reason.trim();
  if (reason === '') return { kind: 'error', message: '`reason` 不能为空。' };
  if (countCodePoints(reason) > MAX_REASON) {
    return { kind: 'error', message: `\`reason\` 不能超过 ${MAX_REASON} 个字符。` };
  }

  let resumePrompt = '';
  if (rawArgs.resume_prompt !== undefined) {
    if (typeof rawArgs.resume_prompt !== 'string') {
      return { kind: 'error', message: '`resume_prompt` 必须是字符串。' };
    }
    resumePrompt = rawArgs.resume_prompt.trim();
    if (countCodePoints(resumePrompt) > MAX_RESUME_PROMPT) {
      return { kind: 'error', message: `\`resume_prompt\` 不能超过 ${MAX_RESUME_PROMPT} 个字符。` };
    }
  }
  let targetSession = '';
  if (rawArgs.target_session !== undefined) {
    if (typeof rawArgs.target_session !== 'string') {
      return { kind: 'error', message: '`target_session` 必须是字符串。' };
    }
    targetSession = rawArgs.target_session.trim();
    if (targetSession !== '' && !/^[A-Za-z0-9._:-]+$/.test(targetSession)) {
      return { kind: 'error', message: '`target_session` 不是有效的会话 id。' };
    }
  }
  if (rawArgs.dry_run !== undefined && typeof rawArgs.dry_run !== 'boolean') {
    return { kind: 'error', message: '`dry_run` 必须是布尔值。' };
  }
  const timings = {};
  if (options.coldBoot === true) {
    for (const [field, key] of timingFields) {
      const value = rawArgs[field];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        return { kind: 'error', message: `\`${field}\` 必须是正整数秒数。` };
      }
      timings[key] = value;
    }
  }
  return { kind: 'ok', reason, resumePrompt, targetSession, dryRun: rawArgs.dry_run === true, timings };
}

/**
 * Build a canonical failure value.
 * @param code - Stable machine code.
 * @param message - Short user-facing explanation.
 * @param extra - Additional lossless fields.
 * @returns The tool's canonical failure value.
 */
function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/**
 * Render one canonical value into model-facing content without throwing.
 * @param _args - Validated arguments (unused).
 * @param value - Canonical value declared by the output schema.
 * @returns One text content block.
 */
function render(_args, value) {
  const result = value !== null && typeof value === 'object' ? value : {};
  if (result.ok === true && result.dryRun === true) {
    return [{ type: 'text', text: `Dry run: ${result.message ?? '重启权限检查完成。'}` }];
  }
  if (result.ok === true) {
    return [{ type: 'text', text: result.message ?? '重启已安排。' }];
  }
  return [{
    type: 'text',
    text: `未执行重启（${result.code ?? 'error'}）：${result.message ?? '未知错误。'}`,
  }];
}

/**
 * Resolve row config with defaults and bounds.
 * @param rawConfig - Loader-provided config.
 * @returns Resolved settings.
 */
function resolveConfig(rawConfig) {
  const source = rawConfig !== null && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
    ? rawConfig
    : {};
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh');
  const profile = (process.env.DSH_PROFILE ?? 'default').replace(/[^A-Za-z0-9._-]/g, '_');

  let pendingDir = typeof source.pendingDir === 'string' && source.pendingDir.trim() !== ''
    ? expandHome(source.pendingDir.trim())
    : path.join(home, 'reboot-resume', profile === '' ? 'default' : profile);
  pendingDir = path.resolve(pendingDir);

  return {
    pendingDir,
    toolOnly: source.toolOnly === true,
    ensurePreset: source.ensurePreset === true,
    allowUnattended: source.allowUnattended === true,
    rebootCommand: normalizeCommand(source.rebootCommand) ?? DEFAULT_REBOOT_COMMAND,
    rebootDelaySeconds: clampInteger(source.rebootDelaySeconds, 5, 2, 120),
    fallbackDelaySeconds: clampInteger(source.fallbackDelaySeconds, 90, 30, 3600),
    staleMs: clampInteger(source.staleAfterSeconds, 7 * 24 * 3600, 3600, 30 * 24 * 3600) * 1000,
    coldBoot: normalizeColdBoot(source.coldBoot, { pendingDir }),
  };
}

/**
 * Normalize an argv command config.
 * @param value - Array or whitespace-separated string.
 * @returns A non-empty argv array, or null when absent/invalid.
 */
function normalizeCommand(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const parts = [];
    for (const part of value) {
      if (typeof part !== 'string' || part === '') return null;
      parts.push(part);
    }
    return parts;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim().split(/\s+/);
  }
  return null;
}

/**
 * Expand a leading `~` or `~/`.
 * @param value - Configured path.
 * @returns Expanded path.
 */
function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Clamp an integer config value.
 * @param value - Raw value.
 * @param fallback - Value used when absent or non-numeric.
 * @param minimum - Inclusive lower bound.
 * @param maximum - Inclusive upper bound.
 * @returns Clamped integer.
 */
function clampInteger(value, fallback, minimum, maximum) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(numeric)));
}

/**
 * Count Unicode code points without splitting surrogate pairs.
 * @param value - Text to count.
 * @returns Code-point count.
 */
function countCodePoints(value) {
  return Array.from(value).length;
}

/**
 * Truncate text to a code-point budget.
 * @param value - Text to truncate.
 * @param limit - Maximum code points.
 * @returns Truncated text.
 */
function truncate(value, limit) {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit).join('');
}

/**
 * Detect a delegated subagent session.
 * @param agent - Calling agent.
 * @returns Delegation depth, zero for a top-level session.
 */
function delegationDepth(agent) {
  let depth = 0;
  const headerDepth = agent?.session?.header?.delegationDepth;
  if (Number.isSafeInteger(headerDepth) && headerDepth > depth) depth = headerDepth;
  const runtimeDepth = agent?.options?.subagentDepth;
  if (Number.isSafeInteger(runtimeDepth) && runtimeDepth > depth) depth = runtimeDepth;
  return depth;
}

/**
 * Resolve after a delay.
 * @param ms - Milliseconds.
 * @returns A promise resolved after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Extract a short, safe error description for logs.
 * @param error - Unknown thrown value.
 * @returns Bounded text.
 */
function safeErrorMessage(error) {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : (() => {
        try {
          return JSON.stringify(error);
        } catch {
          return String(error);
        }
      })();
  return truncate(message, 500);
}
