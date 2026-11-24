/**
 * Jump-host restore tests: the pre-signed request, the remote snippet, and the
 * SSH argv. Nothing here touches a real host or plug.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  armJumpRestore,
  buildPowerRequest,
  buildRemoteScript,
  buildSshArgv,
  preflightJump,
} from '../lib/jump-host.js';

const SESSION = {
  serviceToken: 'service-token',
  ssecurity: 'c2VjdXJpdHktdG9rZW4=',
  userId: '38181245',
};

test('power request is a complete HTTP/1.1 request with a matching length', () => {
  const request = buildPowerRequest({
    session: SESSION,
    did: '532108603',
    siid: 2,
    piid: 1,
    value: true,
  });
  const text = request.request.toString('utf8');
  const split = text.indexOf('\r\n\r\n');
  assert.ok(split > 0, 'request must have a header terminator');
  const head = text.slice(0, split + 4);
  const body = text.slice(split + 4);
  assert.match(head, /^POST \/app\/miotspec\/prop\/set HTTP\/1\.1\r\n/);
  assert.match(head, /Host: api\.io\.mi\.com/);
  assert.match(head, /MIOT-ENCRYPT-ALGORITHM: ENCRYPT-RC4/);
  const declared = Number(/Content-Length: (\d+)/.exec(head)[1]);
  assert.equal(declared, Buffer.byteLength(body));
  assert.equal(declared, request.bytes - Buffer.byteLength(head));
  assert.equal(request.base64, request.request.toString('base64'));
  // The body is a form with the encrypted parameter set.
  for (const key of ['data=', 'rc4_hash__=', 'signature=', 'ssecurity=', '_nonce=']) {
    assert.ok(body.includes(key), `body must contain ${key}`);
  }
});

test('power request refuses to build without a cloud session', () => {
  assert.throws(() => buildPowerRequest({ session: null, did: '1', siid: 2, piid: 1, value: true }), /云端会话/);
});

test('remote script cuts power after shutdown, then restores it after the outage', () => {
  const script = buildRemoteScript({
    offBase64: 'T0ZG',
    onBase64: 'T04=',
    powerCutDelaySeconds: 30,
    outageSeconds: 30,
    shutdownGraceSeconds: 5,
    apiHost: 'api.io.mi.com',
  });
  assert.match(script, /printf %s 'T0ZG' \| base64 -d > \/tmp\/dsh_plug_off\.bin/);
  assert.match(script, /printf %s 'T04=' \| base64 -d > \/tmp\/dsh_plug_on\.bin/);
  assert.match(script, /sleep 35; openssl s_client[^\]]*dsh_plug_off\.bin/);
  assert.match(script, /sleep 30; openssl s_client[^\]]*dsh_plug_on\.bin/);
  assert.match(script, /<\/dev\/null >\/dev\/null 2>&1 &$/);
});

test('ssh argv carries identity, options, target, and the script', () => {
  const argv = buildSshArgv({
    host: 'admin@192.168.8.2',
    identity: '/home/hong/.ssh/dsh_jump',
    sshOptions: ['-o', 'BatchMode=yes'],
    remoteScript: 'echo ok',
  });
  assert.deepEqual(argv, [
    'ssh',
    '-i',
    '/home/hong/.ssh/dsh_jump',
    '-o',
    'BatchMode=yes',
    'admin@192.168.8.2',
    'echo ok',
  ]);
  assert.throws(() => buildSshArgv({ host: '', remoteScript: 'x' }), /host/);
});

test('preflight reports a missing openssl on the jump host', async () => {
  const execFileImpl = (file, args, options, callback) => callback(null, 'dsh-jump-ok\n', '');
  const ok = await preflightJump({ host: 'jump', execFileImpl });
  assert.equal(ok.ok, true);

  const bare = (file, args, options, callback) => callback(null, '', '');
  const bad = await preflightJump({ host: 'jump', execFileImpl: bare });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /openssl|base64/);
});

test('arming reports the ssh failure instead of throwing', async () => {
  const execFileImpl = (file, args, options, callback) => {
    callback(Object.assign(new Error('denied'), { code: 255 }), '', 'Permission denied');
  };
  const result = await armJumpRestore({
    host: 'jump',
    offRequestBase64: 'T0ZG',
    onRequestBase64: 'T04=',
    powerCutDelaySeconds: 30,
    outageSeconds: 30,
    execFileImpl,
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /Permission denied/);
});
