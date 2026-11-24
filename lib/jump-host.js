/**
 * Jump-host restore for a cold boot.
 *
 * The machine cannot power itself back on, so a second always-on device has to
 * do it. This module pre-signs a Xiaomi cloud request that switches the plug
 * back on, ships it to a jump host over SSH, and lets that host send it after a
 * delay.
 *
 * Why a cloud request instead of a local miIO packet: the jump host is a cheap
 * router with BusyBox — no `nc`, no `/dev/udp`, no compiler — but it does have
 * `ssh`, `openssl s_client`, and `base64`. A pre-signed HTTPS request only
 * needs those, and it works even if the plug is on another subnet.
 *
 * The signature stays valid for minutes, and the delay is tens of seconds, so
 * generating the request before the power cut is safe (verified against the
 * live API with a 45 second delay).
 */

import { execFile } from 'node:child_process';

import { encSignature, genNonce, rc4Encrypt, signedNonce } from './xiaomi-cloud.js';

/** Default API host for the Chinese mainland region. */
const DEFAULT_API_HOST = 'api.io.mi.com';
/** Remote request files on the jump host. */
const REMOTE_OFF_FILE = '/tmp/dsh_plug_off.bin';
const REMOTE_ON_FILE = '/tmp/dsh_plug_on.bin';
/** Remote logs of the delayed requests. */
const REMOTE_OFF_LOG = '/tmp/dsh_plug_off.log';
const REMOTE_ON_LOG = '/tmp/dsh_plug_on.log';

/**
 * Build the signed HTTPS request that switches one plug property.
 * @param options - Session, device id, property ids, value, and API host.
 * @returns Request bytes, base64 form, and URL metadata.
 */
export function buildPowerRequest({ session, did, siid, piid, value, apiHost = DEFAULT_API_HOST }) {
  if (session === null || typeof session !== 'object' || !session.serviceToken || !session.ssecurity) {
    throw new Error('跳板机模式需要小米云端会话（serviceToken + ssecurity），请先运行 tools/probe.mjs session 或 login');
  }
  const path = '/app/miotspec/prop/set';
  const url = `https://${apiHost}${path}`;
  const params = {
    data: JSON.stringify({ params: [{ did: String(did), siid, piid, value }] }),
  };
  const nonce = genNonce();
  const nonceSigned = signedNonce(session.ssecurity, nonce);
  params.rc4_hash__ = encSignature('POST', url, nonceSigned, params);
  for (const key of Object.keys(params)) params[key] = rc4Encrypt(nonceSigned, params[key]);
  params.signature = encSignature('POST', url, nonceSigned, params);
  params.ssecurity = session.ssecurity;
  params._nonce = nonce;
  const body = new URLSearchParams(params).toString();

  const head = [
    `POST ${path} HTTP/1.1`,
    `Host: ${apiHost}`,
    'Content-Type: application/x-www-form-urlencoded',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Accept-Encoding: identity',
    'x-xiaomi-protocal-flag-cli: PROTOCAL-HTTP2',
    'MIOT-ENCRYPT-ALGORITHM: ENCRYPT-RC4',
    'User-Agent: Android-7.1.1-1.0.0-ONEPLUS A3010-136-0123456789ab APP/xiaomi.smarthome APPV/62830',
    `Cookie: userId=${session.userId ?? ''}; yetAnotherServiceToken=${session.serviceToken}; `
      + `serviceToken=${session.serviceToken}; locale=zh_CN; timezone=Asia/Shanghai; is_daylight=0; `
      + 'dst_offset=0; channel=MI_APP_STORE; sdkVersion=3.8.6; deviceId=abcdef',
    'Connection: close',
    '', '',
  ].join('\r\n');

  const request = Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(body, 'utf8')]);
  return {
    url,
    apiHost,
    bytes: request.length,
    request,
    base64: request.toString('base64'),
    value,
  };
}

/**
 * Build the remote shell snippet the jump host runs.
 *
 * The machine shuts down first, so the jump host owns both power transitions:
 *
 *   sleep (shutdown grace + cut delay) -> send "plug off"
 *   sleep outage                      -> send "plug on"
 *
 * Both requests are pre-signed HTTPS requests, so the host only needs base64
 * and openssl. The snippet backgrounds itself so the SSH session returns and
 * the local shutdown can proceed.
 *
 * @param options - Base64 requests, delays, API host, and file paths.
 * @returns One remote shell command string.
 */
export function buildRemoteScript({
  offBase64,
  onBase64,
  powerCutDelaySeconds,
  outageSeconds,
  shutdownGraceSeconds = 0,
  apiHost = DEFAULT_API_HOST,
  offFile = REMOTE_OFF_FILE,
  onFile = REMOTE_ON_FILE,
  offLog = REMOTE_OFF_LOG,
  onLog = REMOTE_ON_LOG,
}) {
  const cut = Math.max(1, Math.round(powerCutDelaySeconds + shutdownGraceSeconds));
  const outage = Math.max(1, Math.round(outageSeconds));
  const send = (file, log) => `openssl s_client -quiet -connect ${apiHost}:443 -servername ${apiHost} < ${file} > ${log} 2>&1`;
  return [
    `printf %s '${offBase64}' | base64 -d > ${offFile}`,
    `printf %s '${onBase64}' | base64 -d > ${onFile}`,
    `nohup sh -c 'sleep ${cut}; ${send(offFile, offLog)}; sleep ${outage}; ${send(onFile, onLog)}' `
      + '</dev/null >/dev/null 2>&1 &',
  ].join('; ');
}

/**
 * Build the local SSH argv that arms the jump host.
 * @param options - SSH target, identity, options, and remote script.
 * @returns Argv for `ssh`.
 */
export function buildSshArgv({ host, identity, sshOptions = [], remoteScript }) {
  if (typeof host !== 'string' || host.trim() === '') throw new Error('restore.jump.host 为空');
  const argv = ['ssh'];
  if (typeof identity === 'string' && identity !== '') argv.push('-i', identity);
  for (const option of sshOptions) {
    if (typeof option === 'string' && option !== '') argv.push(option);
  }
  argv.push(host.trim(), remoteScript);
  return argv;
}

/**
 * Run one argv and capture its result.
 * @param options - Executable, arguments, timeout, and an execFile implementation.
 * @returns Normalized result.
 */
function runCapture({ executable, args, timeoutMs, execFileImpl = execFile }) {
  return new Promise((resolve) => {
    execFileImpl(
      executable,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error !== null && error !== undefined) {
          resolve({
            ok: false,
            exitCode: typeof error.code === 'number' ? error.code : null,
            detail: String(stderr ?? '').trim() || error.message || '命令执行失败',
          });
          return;
        }
        resolve({ ok: true, exitCode: 0, detail: String(stdout ?? '').trim() });
      },
    );
  });
}

/**
 * Check that the jump host is reachable over key auth and has the tools the
 * delayed request needs. Read-only: it changes nothing on the host or the plug.
 * @param options - SSH target, identity, options, timeout, and execFile.
 * @returns Reachability and tool availability.
 */
export async function preflightJump({ host, identity, sshOptions, timeoutMs = 8000, execFileImpl }) {
  // Padavan's busybox shell has no `command` builtin, so probe by execution.
  const remote = 'openssl version >/dev/null 2>&1 && echo dsh-jump-ok-check | base64 >/dev/null 2>&1 '
    + '&& echo dsh-jump-ok';
  const argv = buildSshArgv({ host, identity, sshOptions, remoteScript: remote });
  const [executable, ...args] = argv;
  const result = await runCapture({ executable, args, timeoutMs, execFileImpl });
  if (!result.ok) return { ok: false, detail: `跳板机不可达：${result.detail}` };
  if (!result.detail.includes('dsh-jump-ok')) {
    return { ok: false, detail: '跳板机缺少 openssl 或 base64，无法发送延迟请求。' };
  }
  return { ok: true, detail: `跳板机 ${host} 可执行 openssl + base64。` };
}

/**
 * Ship and arm the delayed power cycle.
 * @param options - SSH target, identity, options, both requests, delays, and execFile.
 * @returns Arm result; the caller aborts the cold boot on failure.
 */
export async function armJumpRestore({
  host,
  identity,
  sshOptions,
  offRequestBase64,
  onRequestBase64,
  powerCutDelaySeconds,
  outageSeconds,
  shutdownGraceSeconds = 0,
  apiHost = DEFAULT_API_HOST,
  timeoutMs = 10000,
  execFileImpl,
}) {
  const remoteScript = buildRemoteScript({
    offBase64: offRequestBase64,
    onBase64: onRequestBase64,
    powerCutDelaySeconds,
    outageSeconds,
    shutdownGraceSeconds,
    apiHost,
  });
  const argv = buildSshArgv({ host, identity, sshOptions, remoteScript });
  const [executable, ...args] = argv;
  const result = await runCapture({ executable, args, timeoutMs, execFileImpl });
  return {
    ...result,
    detail: result.ok
      ? `已在 ${host} 上安排：${Math.round(powerCutDelaySeconds + shutdownGraceSeconds)}s 后断电，`
        + `${Math.round(outageSeconds)}s 后上电。`
      : result.detail,
  };
}
