/**
 * Protocol tests for the miIO plug client and the cold-boot planner.
 *
 * A fake plug speaks the real miIO wire format (handshake, MD5 checksum,
 * AES-128-CBC JSON), so the client is exercised end to end without touching a
 * real relay:
 *
 *   node --test test/
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { after, before, test } from 'node:test';

import { normalizeColdBoot, planColdBoot, runRestoreCommand } from '../lib/cold-boot.js';
import {
  MiioPlug,
  decryptPacket,
  encryptPacket,
  handshakePacket,
  parsePacket,
  verifyChecksum,
} from '../lib/miio.js';
import { plugPower, plugStatus } from '../lib/plug.js';

const TOKEN = '00112233445566778899aabbccddeeff';
const DEVICE_ID = 0x1a2b3c4d;

/** @param value - Bytes. @returns MD5 digest. */
function md5(value) {
  return crypto.createHash('md5').update(value).digest();
}

/**
 * Run a fake plug on an ephemeral port.
 * @param options - Token and initial relay state.
 * @returns Server handle with address and state controls.
 */
function startFakePlug({ token, power = 'on' }) {
  const sockets = new Set();
  const state = { power, calls: [] };
  const server = dgram.createSocket('udp4');

  server.on('message', (message, remote) => {
    const header = parsePacket(message);
    sockets.add(remote);
    if (header.magic === 0x2131 && header.body.length === 0) {
      const reply = Buffer.alloc(16);
      reply.writeUInt16BE(0x2131, 0);
      reply.writeUInt16BE(32, 2);
      reply.writeUInt32BE(0xffffffff, 4);
      reply.writeUInt32BE(DEVICE_ID, 8);
      reply.writeUInt32BE(Math.floor(Date.now() / 1000), 12);
      server.send(Buffer.concat([reply, md5(Buffer.concat([reply, Buffer.from(token, 'hex')]))]), remote.port, remote.address);
      return;
    }
    // A real device drops packets whose checksum does not verify, so a wrong
    // token looks like silence rather than an error reply.
    if (!verifyChecksum(header, message, token)) return;
    const request = decryptPacket(header, token);
    state.calls.push(request);
    let result;
    if (request.method === 'get_prop') result = [state.power];
    else if (request.method === 'set_power') {
      state.power = request.params[0];
      result = ['ok'];
    } else if (request.method === 'miIO.info') result = { model: 'fake.plug.v1', fw_ver: '1.0.0' };
    else result = [];
    server.send(encryptPacket({ token, deviceId: DEVICE_ID, stamp: header.stamp, payload: { id: request.id, result } }), remote.port, remote.address);
  });

  return new Promise((resolve) => {
    server.bind(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        state,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('handshake packet has the documented shape', () => {
  const packet = handshakePacket();
  assert.equal(packet.length, 32);
  assert.equal(packet.readUInt16BE(0), 0x2131);
  assert.equal(packet.readUInt16BE(2), 32);
  assert.equal(packet.readUInt32BE(4), 0xffffffff);
  // Devices ignore the handshake checksum; the reference client sends all ones.
  assert.ok(packet.subarray(16).every((byte) => byte === 0xff));
});

test('miIO client reads and switches the relay against a fake device', async () => {
  const fake = await startFakePlug({ token: TOKEN, power: 'on' });
  const plug = new MiioPlug({ host: '127.0.0.1', port: fake.port, token: TOKEN, timeoutMs: 2000 });
  try {
    assert.equal(await plug.power(), 'on');
    await plug.setPower('off');
    assert.equal(await plug.power(), 'off');
    assert.equal(fake.state.calls.filter((call) => call.method === 'set_power').length, 1);
    const info = await plug.info();
    assert.equal(info.model, 'fake.plug.v1');
  } finally {
    await fake.close();
  }
});

test('miIO client rejects a wrong token instead of trusting the reply', async () => {
  const fake = await startFakePlug({ token: TOKEN, power: 'on' });
  const plug = new MiioPlug({
    host: '127.0.0.1',
    port: fake.port,
    token: 'ffeeddccbbaa99887766554433221100',
    timeoutMs: 1500,
  });
  try {
    await assert.rejects(() => plug.power(), /checksum|timeout/);
  } finally {
    await fake.close();
  }
});

/**
 * Run a fake MIoT-spec plug (like the 米家智能插座2) that only answers
 * get_properties/set_properties and rejects the legacy get_prop.
 * @param options - Token and initial relay state.
 * @returns Server handle.
 */
function startFakeMiotPlug({ token, initial = false }) {
  const state = { on: initial };
  const server = dgram.createSocket('udp4');
  server.on('message', (message, remote) => {
    const header = parsePacket(message);
    if (header.magic === 0x2131 && header.body.length === 0) {
      const reply = Buffer.alloc(16);
      reply.writeUInt16BE(0x2131, 0);
      reply.writeUInt16BE(32, 2);
      reply.writeUInt32BE(0xffffffff, 4);
      reply.writeUInt32BE(DEVICE_ID, 8);
      reply.writeUInt32BE(100, 12);
      server.send(
        Buffer.concat([reply, md5(Buffer.concat([reply, Buffer.from(token, 'hex')]))]),
        remote.port,
        remote.address,
      );
      return;
    }
    if (!verifyChecksum(header, message, token)) return;
    const request = decryptPacket(header, token);
    let result;
    if (request.method === 'get_properties') {
      result = request.params.map((p) => ({ did: p.did, siid: p.siid, piid: p.piid, code: 0, value: state.on }));
    } else if (request.method === 'set_properties') {
      result = request.params.map((p) => {
        state.on = p.value === true;
        return { did: p.did, siid: p.siid, piid: p.piid, code: 0 };
      });
    } else if (request.method === 'miIO.info') {
      result = { model: 'fake.miot.plug', fw_ver: '1.0' };
    } else {
      result = { code: -9999, message: 'user ack timeout' };
    }
    server.send(
      encryptPacket({ token, deviceId: DEVICE_ID, stamp: header.stamp, payload: { id: request.id, result } }),
      remote.port,
      remote.address,
    );
  });
  return new Promise((resolve) => {
    server.bind(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, state, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

test('MIoT-spec plug is read and switched through get/set_properties', async () => {
  const fake = await startFakeMiotPlug({ token: TOKEN, initial: false });
  const plug = {
    host: '127.0.0.1',
    port: fake.port,
    token: TOKEN,
    did: '1',
    name: 'fake',
    model: 'fake.miot.plug',
    source: 'config',
    switchSpec: { siid: 2, piid: 1 },
    client: new MiioPlug({ host: '127.0.0.1', port: fake.port, token: TOKEN, timeoutMs: 2000 }),
  };
  try {
    const before = await plugStatus(plug);
    assert.equal(before.power, 'off');
    assert.equal(before.protocol, 'miot');
    assert.equal(await plugPower(plug, 'on'), 'on');
    assert.equal(fake.state.on, true);
    assert.equal(await plugPower(plug, 'off'), 'off');
    assert.equal(fake.state.on, false);
  } finally {
    await fake.close();
  }
});

test('cold boot refuses to plan without a restore path', () => {
  const coldBoot = normalizeColdBoot(
    { enabled: true, plug: { host: '192.168.8.9', token: TOKEN } },
    { pendingDir: '/tmp/reboot-resume-test' },
  );
  const plan = planColdBoot({ coldBoot, plugStatus: { host: '192.168.8.9', power: 'on' } });
  assert.equal(plan.ok, false);
  assert.ok(plan.blockers.some((line) => line.includes('恢复手段')));
});

test('cold boot plans a power cut when a restore command is configured', () => {
  const coldBoot = normalizeColdBoot(
    {
      enabled: true,
      plug: { host: '192.168.8.9', token: TOKEN },
      restore: { mode: 'command', command: ['ssh', 'jump', 'sleep 30'] },
      outageSeconds: 20,
    },
    { pendingDir: '/tmp/reboot-resume-test' },
  );
  const plan = planColdBoot({ coldBoot, plugStatus: { host: '192.168.8.9', power: 'on' } });
  assert.equal(plan.ok, true);
  assert.ok(plan.steps.some((line) => line.includes('ssh jump')));
});

test('cold boot blocks when the plug is not on', () => {
  const coldBoot = normalizeColdBoot(
    {
      enabled: true,
      plug: { host: '192.168.8.9', token: TOKEN },
      restore: { mode: 'command', command: ['true'] },
    },
    { pendingDir: '/tmp/reboot-resume-test' },
  );
  const plan = planColdBoot({ coldBoot, plugStatus: { host: '192.168.8.9', power: 'off' } });
  assert.equal(plan.ok, false);
});

test('restore command reports a non-zero exit instead of throwing', async () => {
  const execFile = (file, args, options, callback) => {
    callback(Object.assign(new Error('boom'), { code: 3 }), '', 'boom');
  };
  const outcome = await runRestoreCommand({ command: ['false'], execFile });
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /boom/);
});
