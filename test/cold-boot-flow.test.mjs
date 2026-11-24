/**
 * End-to-end control-flow tests for the cold-boot tool.
 *
 * The plugin is loaded with a fake Cordis context (tools, systemPrompt,
 * Schedule, approval) and a fake miIO plug, so the complete order of
 * operations is asserted without touching real hardware:
 *
 *   schedule continuation -> write pending record -> run restore command ->
 *   switch the plug off -> close the turn
 *
 * and, on any failure before the power cut, the durable parts are rolled back.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { apply } from '../index.js';
import { decryptPacket, encryptPacket, parsePacket, verifyChecksum } from '../lib/miio.js';

const TOKEN = '00112233445566778899aabbccddeeff';
const DEVICE_ID = 0x0badf00d;

/** @param value - Bytes. @returns MD5 digest. */
function md5(value) {
  return crypto.createHash('md5').update(value).digest();
}

/**
 * Start a fake Wi-Fi plug.
 * @param options - Token and initial relay state.
 * @returns Server handle.
 */
function startFakePlug({ token, power = 'on' }) {
  const state = { power, calls: [] };
  const server = dgram.createSocket('udp4');
  server.on('message', (message, remote) => {
    const header = parsePacket(message);
    if (header.magic === 0x2131 && header.body.length === 0) {
      const reply = Buffer.alloc(16);
      reply.writeUInt16BE(0x2131, 0);
      reply.writeUInt16BE(32, 2);
      reply.writeUInt32BE(0xffffffff, 4);
      reply.writeUInt32BE(DEVICE_ID, 8);
      reply.writeUInt32BE(Math.floor(Date.now() / 1000), 12);
      server.send(
        Buffer.concat([reply, md5(Buffer.concat([reply, Buffer.from(token, 'hex')]))]),
        remote.port,
        remote.address,
      );
      return;
    }
    if (!verifyChecksum(header, message, token)) return;
    const request = decryptPacket(header, token);
    state.calls.push(request);
    let result = [];
    if (request.method === 'get_prop') result = [state.power];
    else if (request.method === 'set_power') {
      state.power = request.params[0];
      result = ['ok'];
    } else if (request.method === 'miIO.info') result = { model: 'fake.plug', fw_ver: '1.0' };
    server.send(
      encryptPacket({ token, deviceId: DEVICE_ID, stamp: header.stamp, payload: { id: request.id, result } }),
      remote.port,
      remote.address,
    );
  });
  return new Promise((resolve) => {
    server.bind(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * Build the fake Cordis context the plugin understands.
 * @returns Context handle exposing registered tools and created tasks.
 */
function createContext() {
  const tools = new Map();
  const sections = new Map();
  const tasks = [];
  const context = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
      get: (name) => tools.get(name),
    },
    systemPrompt: {
      getSectionOrder: () => 600,
      section(definition) {
        sections.set(definition.name, definition);
      },
    },
    schedule: {
      async create(input, sessionId) {
        const entry = { id: `task-${tasks.length + 1}`, sessionId, ...input };
        tasks.push(entry);
        return entry;
      },
      async view({ id }) {
        return tasks.find((task) => task.id === id) ?? { code: 'schedule_not_found' };
      },
      async run() {
        return { code: 'ok' };
      },
      async edit({ id, action }) {
        if (action === 'delete') {
          const index = tasks.findIndex((task) => task.id === id);
          if (index >= 0) tasks.splice(index, 1);
        }
        return { code: 'ok' };
      },
    },
    inject(_names, callback) {
      callback(context);
      return () => {};
    },
    effect(callback) {
      const dispose = callback();
      return () => dispose?.();
    },
    get(name) {
      if (name === 'approval') {
        return { request: async () => 'allowed-once' };
      }
      return undefined;
    },
  };
  return { context, tools, tasks, sections };
}

/**
 * Run one test body with a fake plug and a temporary state directory.
 * @param callback - Receives the fake plug, state directory, and context handle.
 */
async function withRig(callback) {
  const fake = await startFakePlug({ token: TOKEN });
  const pendingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reboot-resume-cold-'));
  await fs.writeFile(
    path.join(pendingDir, 'plug.json'),
    `${JSON.stringify({
      version: 1,
      device: {
        host: `127.0.0.1:${fake.port}`,
        token: TOKEN,
        did: String(DEVICE_ID),
        name: 'fake',
        model: 'fake.plug',
      },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  try {
    await callback({ fake, pendingDir, ...createContext() });
  } finally {
    await fake.close();
    await fs.rm(pendingDir, { recursive: true, force: true });
  }
}

/**
 * Load the plugin into a fake context with the given cold-boot block.
 * @param context - Fake Cordis context.
 * @param pendingDir - State directory.
 * @param coldBoot - Raw cold-boot configuration.
 * @returns Registered tools by name.
 */
function loadPlugin({ context, pendingDir, coldBoot, allowUnattended = true }) {
  apply(context, { toolOnly: true, pendingDir, allowUnattended, coldBoot });
  return context.tools;
}

test('dry run reports readiness and leaves the plug on', async () => {
  await withRig(async ({ fake, pendingDir, context }) => {
    loadPlugin({
      context,
      pendingDir,
      coldBoot: {
      enabled: true,
      haltCommand: ['/bin/true'],
      restore: { mode: 'command', command: ['/bin/true'] },
      outageSeconds: 20,
    },
    });
    const tool = context.tools.get('system_cold_boot');
    assert.ok(tool !== undefined, 'the cold-boot tool must be registered');

    const result = await tool.execute({ reason: 'PCIe 重新枚举', dry_run: true }, { agent: { session: { id: 's-1' } } });
    assert.equal(result.ok, true);
    assert.equal(result.code, 'cold_boot_ready');
    assert.equal(fake.state.power, 'on');
    assert.equal(fake.state.calls.filter((call) => call.method === 'set_power').length, 0);
  });
});

test('cold boot schedules the continuation, arms restore, then cuts power', async () => {
  await withRig(async ({ fake, pendingDir, context, tasks }) => {
    loadPlugin({
      context,
      pendingDir,
      coldBoot: {
      enabled: true,
      haltCommand: ['/bin/true'],
      restore: { mode: 'command', command: ['/bin/true'] },
      outageSeconds: 20,
    },
    });
    const tool = context.tools.get('system_cold_boot');
    const result = await tool.execute({ reason: '驱动需要真正断电' }, { agent: { session: { id: 's-1' } } });

    assert.equal(result.ok, true);
    assert.equal(result.code, 'cold_boot_started');
    // The local relay is untouched: the machine shuts down first and the
    // restore mechanism owns the power cycle.
    assert.equal(fake.state.power, 'on');
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].title, /冷启动续跑/);
    assert.match(tasks[0].prompt, /system_cold_boot/);
    // grace 5 + cut 30 + outage 20 (from this test's config) + fallback 90
    assert.equal(tasks[0].timing.after_seconds, 5 + 30 + 20 + 90);

    const record = JSON.parse(await fs.readFile(path.join(pendingDir, 'pending.json'), 'utf8'));
    assert.equal(record.kind, 'cold-boot');
    assert.equal(record.restoreMode, 'command');
    assert.equal(record.powerCutDelaySeconds, 30);
    assert.equal(record.plug.tokenConfigured, true);
    assert.equal(record.plug.host, '127.0.0.1');
  });
});

test('a failed restore command aborts before the power cut and rolls back', async () => {
  await withRig(async ({ fake, pendingDir, context, tasks }) => {
    loadPlugin({
      context,
      pendingDir,
      coldBoot: {
      enabled: true,
      haltCommand: ['/bin/true'],
      restore: { mode: 'command', command: ['/bin/false'] },
      outageSeconds: 20,
    },
    });
    const tool = context.tools.get('system_cold_boot');
    const result = await tool.execute({ reason: '测试回滚' }, { agent: { session: { id: 's-1' } } });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'restore_failed');
    assert.equal(fake.state.power, 'on');
    assert.equal(tasks.length, 0);
    await assert.rejects(() => fs.access(path.join(pendingDir, 'pending.json')));
  });
});

test('cold boot is blocked when no restore path is configured', async () => {
  await withRig(async ({ fake, pendingDir, context }) => {
    loadPlugin({ context, pendingDir, coldBoot: { enabled: true, haltCommand: ['/bin/true'], outageSeconds: 20 } });
    const tool = context.tools.get('system_cold_boot');
    const result = await tool.execute({ reason: '没有恢复手段' }, { agent: { session: { id: 's-1' } } });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'cold_boot_blocked');
    assert.equal(fake.state.power, 'on');
  });
});
