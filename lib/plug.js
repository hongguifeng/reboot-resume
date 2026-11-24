/**
 * Plug resolution: turn plugin configuration and the on-disk cache into one
 * concrete Wi-Fi plug, then expose the three operations the cold-boot flow
 * needs — status, power off, power on.
 *
 * Resolution order:
 *   1. explicit `plug.host` + `plug.token` in configuration;
 *   2. the cached device from a previous cloud sign-in;
 *   3. a fresh Xiaomi cloud sign-in with the configured (or stored) account.
 *
 * The token is a device credential, so it lives in a 0600 cache file beside the
 * plugin state, not in a world-readable profile file.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { MiioPlug, MIIO_PORT, normalizeToken } from './miio.js';
import { listDevices, login, maskToken, selectPlug } from './xiaomi-cloud.js';

/** Cache schema version. */
const CACHE_VERSION = 1;

/**
 * Read the cloud/plug cache.
 * @param file - Absolute cache path.
 * @returns Cache object or null when absent or unreadable.
 */
export async function readCache(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write the cloud/plug cache atomically with owner-only permissions.
 * @param file - Absolute cache path.
 * @param value - Cache object.
 */
export async function writeCache(file, value) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ version: CACHE_VERSION, ...value }, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.chmod(temporary, 0o600).catch(() => {});
  await fs.rename(temporary, file);
}

/**
 * Choose the plug when the configuration has no selector: prefer the single
 * device whose model looks like a plug, otherwise require an explicit choice.
 * @param devices - Devices that have both a LAN address and a token.
 * @returns The selected device.
 */
function defaultPlug(devices) {
  if (devices.length === 0) {
    throw new Error('账号下没有同时带 IP 和 token 的设备；请确认插座已添加到该小米账号。');
  }
  const plugs = devices.filter((device) => device.model.includes('plug'));
  if (plugs.length === 1) return plugs[0];
  if (devices.length === 1) return devices[0];
  const candidates = (plugs.length > 0 ? plugs : devices)
    .map((device) => `${device.name || '(未命名)'} ${device.model} ${device.did}`)
    .join('；');
  throw new Error(`账号下有多个可控制设备，请在 coldBoot.plug.selector 里指定 did 或 name：${candidates}`);
}

/**
 * Select the device for a cloud refresh, honoring a configured selector.
 * @param devices - Raw device rows.
 * @param selector - Configured did/name/model filter.
 * @returns The selected device.
 */
function chooseDevice(devices, selector) {
  const usable = devices.filter((device) => device.token !== '' && device.host !== '');
  const hasSelector = ['did', 'name', 'model'].some((key) => String(selector?.[key] ?? '') !== '');
  return hasSelector ? selectPlug(usable, selector) : defaultPlug(usable);
}

/**
 * Split an optional `host:port` into a host and port.
 * @param value - Configured host.
 * @returns Host and port.
 */
function splitHost(value) {
  const text = String(value ?? '').trim();
  if (text === '') return { host: '', port: MIIO_PORT };
  const match = /^(.*):(\d+)$/.exec(text);
  if (match === null) return { host: text, port: MIIO_PORT };
  return { host: match[1], port: Number(match[2]) };
}

/**
 * Resolve the plug that should be driven.
 * @param options - Resolved config, cache path, logger, and credential lookup.
 * @returns Plug descriptor with a shared {@link MiioPlug}.
 */
export async function resolvePlug({ config, cacheFile, log, credentials, forceRefresh = false }) {
  const cache = await readCache(cacheFile);
  const explicitHost = String(config.plug?.host ?? '').trim();
  const explicitToken = String(config.plug?.token ?? '').trim();

  if (explicitHost !== '' && explicitToken !== '') {
    const { host, port } = splitHost(explicitHost);
    return buildPlug({
      host,
      port,
      token: explicitToken,
      device: cache?.device,
      source: 'config',
      switchSpec: config.plug?.switch,
    });
  }

  if (!forceRefresh && cache?.device?.host && cache?.device?.token) {
    const { host, port } = splitHost(cache.device.host);
    return buildPlug({
      host,
      port,
      token: cache.device.token,
      device: cache.device,
      source: 'cache',
      switchSpec: config.plug?.switch,
    });
  }

  // A cached browser session can refresh a moved device without a password.
  if (forceRefresh && cache?.session?.serviceToken && cache?.session?.ssecurity) {
    const devices = await listDevices({ session: cache.session });
    const device = chooseDevice(devices, config.plug?.selector);
    await writeCache(cacheFile, { session: cache.session, device, updatedAt: new Date().toISOString() });
    const { host, port } = splitHost(device.host);
    log?.info?.(`plug ${device.name || device.did} refreshed from the cached session at ${host}`);
    return buildPlug({ host, port, token: device.token, device, source: 'cloud', switchSpec: config.plug?.switch });
  }

  const username = String(credentials?.username ?? '').trim();
  const password = String(credentials?.password ?? '');
  if (username === '' || password === '') {
    throw new Error(
      '没有可用的插座信息：请先运行 tools/probe.mjs session（浏览器会话）或 login（账号密码）缓存设备，'
      + '或在配置里填 plug.host/plug.token。',
    );
  }

  log?.info?.('signing in to the Xiaomi account to discover the plug');
  const session = await login({ username, password });
  const devices = await listDevices({ session });
  const device = chooseDevice(devices, config.plug?.selector);
  await writeCache(cacheFile, {
    session,
    device,
    updatedAt: new Date().toISOString(),
  });
  const { host, port } = splitHost(device.host);
  log?.info?.(`plug ${device.name || device.did} resolved at ${host} (token ${maskToken(device.token)})`);
  return buildPlug({ host, port, token: device.token, device, source: 'cloud' });
}

/**
 * Construct the plug handle.
 * @param options - Host, port, token, device metadata, source, and switch ids.
 * @returns Plug descriptor.
 */
function buildPlug({ host, port, token, device, source, switchSpec }) {
  if (host === '') throw new Error('插座 IP 为空：请重新登录小米账号刷新设备列表，或显式配置 plug.host。');
  const normalized = normalizeToken(token);
  return {
    host,
    port,
    token: normalized,
    did: String(device?.did ?? ''),
    name: String(device?.name ?? ''),
    model: String(device?.model ?? ''),
    source,
    // MIoT plugs expose the relay as a spec property; older plugs answer the
    // legacy get_prop/set_power methods instead.
    switchSpec: {
      siid: Number.isInteger(switchSpec?.siid) ? switchSpec.siid : 2,
      piid: Number.isInteger(switchSpec?.piid) ? switchSpec.piid : 1,
    },
    client: new MiioPlug({ host, token: normalized, port }),
  };
}

/**
 * Read the relay through the MIoT spec, then through the legacy method.
 * @param plug - Plug descriptor.
 * @returns `on`, `off`, or `unknown`, plus which protocol answered.
 */
async function readRelay(plug) {
  const { siid, piid } = plug.switchSpec;
  try {
    const rows = await plug.client.call('get_properties', [{ did: `${siid}-${piid}`, siid, piid }]);
    const value = Array.isArray(rows) ? rows.find((row) => row?.siid === siid && row?.piid === piid)?.value : undefined;
    if (typeof value === 'boolean') return { power: value ? 'on' : 'off', protocol: 'miot' };
    if (value === 'on' || value === 'off') return { power: value, protocol: 'miot' };
  } catch {
    // Fall through to the legacy method below.
  }
  const power = await plug.client.power();
  if (power === 'on' || power === 'off') return { power, protocol: 'legacy' };
  return { power: 'unknown', protocol: 'unknown' };
}

/**
 * Read the relay state and device info in one pass.
 * @param plug - Plug descriptor.
 * @returns Status snapshot used by tools and diagnostics.
 */
export async function plugStatus(plug) {
  const { power, protocol } = await readRelay(plug);
  let info = {};
  try {
    info = await plug.client.info();
  } catch {
    // Older plugs do not implement miIO.info; the power state is enough.
  }
  return {
    power,
    model: typeof info.model === 'string' ? info.model : plug.model,
    firmware: typeof info.fw_ver === 'string' ? info.fw_ver : '',
    protocol,
    host: plug.host,
    did: plug.did,
    name: plug.name,
    source: plug.source,
  };
}

/**
 * Switch the relay and read the resulting state.
 * @param plug - Plug descriptor.
 * @param state - `'on'` or `'off'`.
 * @returns Power state reported after the command.
 */
export async function plugPower(plug, state) {
  if (state !== 'on' && state !== 'off') throw new Error(`invalid power state ${String(state)}`);
  const { siid, piid } = plug.switchSpec;
  let switched = false;
  try {
    const rows = await plug.client.call('set_properties', [{
      did: `set-${siid}-${piid}`,
      siid,
      piid,
      value: state === 'on',
    }]);
    const acknowledged = Array.isArray(rows)
      && rows.length === 1
      && rows[0]?.code === 0
      && rows[0]?.siid === siid
      && rows[0]?.piid === piid;
    if (!acknowledged) throw new Error('miot set_properties was not acknowledged');
    switched = true;
  } catch {
    // Older plugs only implement set_power.
  }
  if (!switched) await plug.client.setPower(state);
  const { power } = await readRelay(plug);
  return power;
}

/**
 * Check that a plug can be reached and reports a relay state.
 * @param plug - Plug descriptor.
 * @returns Reachability report.
 */
export async function plugPreflight(plug) {
  try {
    const status = await plugStatus(plug);
    return { ok: true, status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
