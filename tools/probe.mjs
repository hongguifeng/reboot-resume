#!/usr/bin/env node
/**
 * Standalone probe for the cold-boot plug path.
 *
 * It exercises the same modules the plugin uses, without DSH and without ever
 * cutting power unless `off --yes` is passed explicitly:
 *
 *   node tools/probe.mjs login --user 你的小米账号 --password '...'
 *   node tools/probe.mjs list
 *   node tools/probe.mjs status
 *   node tools/probe.mjs on
 *   node tools/probe.mjs off --yes
 *
 * The sign-in result (service token, ssecurity, device address, device token)
 * is cached in `$DSH_HOME/reboot-resume/<profile>/plug.json` with mode 0600, so
 * the plugin can reuse it without the account password.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { plugPower, plugStatus, readCache, resolvePlug, writeCache } from '../lib/plug.js';
import {
  fetchCaptcha,
  listDevices,
  login,
  maskToken,
  parseCookieHeader,
  sessionFromParts,
} from '../lib/xiaomi-cloud.js';

const log = {
  info: (message) => console.error(`[probe] ${message}`),
  warn: (message) => console.error(`[probe] ${message}`),
};

/** Absolute path of the plugin state directory, matching index.js. */
function stateDir() {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
  const profile = (process.env.DSH_PROFILE ?? 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(home, 'reboot-resume', profile === '' ? 'default' : profile);
}

/** @returns Absolute path of the plug cache. */
function cacheFile() {
  return path.join(stateDir(), 'plug.json');
}

/**
 * Parse `--flag value` pairs.
 * @param argv - Arguments after the command name.
 * @returns Flag map.
 */
function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
      continue;
    }
    flags[name] = next;
    index += 1;
  }
  return flags;
}

/**
 * Build a plug descriptor from the cache or explicit flags.
 * @param flags - Parsed flags.
 * @returns Plug descriptor.
 */
async function plugFromCache(flags) {
  const cache = await readCache(cacheFile());
  const config = {
    plug: {
      host: typeof flags.host === 'string' ? flags.host : '',
      token: typeof flags.token === 'string' ? flags.token : '',
      selector: {},
    },
    account: { username: '', password: '' },
  };
  const credentials = {
    username: process.env.XIAOMI_USERNAME ?? '',
    password: process.env.XIAOMI_PASSWORD ?? '',
  };
  if (cache?.device === undefined && config.plug.host === '' && credentials.username === '') {
    throw new Error(`没有缓存的插座信息（${cacheFile()}），请先运行 login。`);
  }
  return resolvePlug({ config, cacheFile: cacheFile(), log, credentials });
}

/** @returns Path of the pending sign-in session (cookies for a captcha retry). */
function loginSessionFile() {
  return path.join(stateDir(), 'login-session.json');
}

/**
 * Sign in and cache the device list.
 * @param flags - Parsed command flags.
 */
async function commandLogin(flags) {
  const saved = await fs.readFile(loginSessionFile(), 'utf8').then(JSON.parse).catch(() => null);
  const username = (
    typeof flags.user === 'string' ? flags.user : (saved?.username ?? process.env.XIAOMI_USERNAME ?? '')
  ).trim();
  const password = typeof flags.password === 'string' ? flags.password : process.env.XIAOMI_PASSWORD ?? '';
  const icode = typeof flags.icode === 'string' ? flags.icode : '';
  if (username === '' || password === '') {
    throw new Error('用法：probe.mjs login --user <账号> --password <密码>（或设置 XIAOMI_USERNAME/XIAOMI_PASSWORD）');
  }

  let session;
  try {
    session = await login({ username, password, icode, cookies: saved?.cookies });
  } catch (error) {
    if (error?.details?.code === 87001) {
      await fs.mkdir(stateDir(), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        loginSessionFile(),
        `${JSON.stringify({ username, cookies: error.details.cookies }, null, 2)}\n`,
        { mode: 0o600 },
      );
      let image = '(小米没有返回验证码地址)';
      if (error.details.captchaUrl !== '') {
        image = await fetchCaptcha({
          cookies: error.details.cookies,
          captchaUrl: error.details.captchaUrl,
          file: path.join(stateDir(), 'login-captcha.png'),
        }).catch((captchaError) => `(下载失败：${captchaError.message})`);
      }
      throw new Error(`需要验证码：打开 ${image} 看图，然后重新运行 login --icode <验证码>`);
    }
    throw error;
  }
  await fs.rm(loginSessionFile(), { force: true });
  log.info(`login ok: userId ${session.userId || '(unknown)'}`);
  await persistDevices(session);
}

/**
 * Print the account's devices and cache the first usable plug.
 * @param session - Signed-in session.
 */
async function persistDevices(session) {
  const devices = await listDevices({ session });
  const plugs = devices.filter((device) => device.token !== '');
  log.info(`devices: ${devices.length}, with local token: ${plugs.length}`);
  for (const device of devices) {
    console.log(
      [
        device.did || '-',
        device.name || '(未命名)',
        device.model || '-',
        device.host || '-',
        device.isOnline ? 'online' : 'offline',
        device.token === '' ? 'no-token' : `token ${maskToken(device.token)}`,
      ].join('\t'),
    );
  }
  const candidates = plugs.filter((device) => device.host !== '');
  if (candidates.length === 0) {
    throw new Error('账号下没有带 IP 和 token 的设备；请确认插座已添加到该小米账号。');
  }
  const plugModels = candidates.filter((device) => device.model.includes('plug'));
  const device = plugModels.length === 1 ? plugModels[0] : candidates[0];
  if (candidates.length > 1) {
    log.warn(
      `账号下有 ${candidates.length} 个可控制设备；默认选 ${device.name || device.did}，`
      + '多插座时请在 coldBoot.plug.selector 指定 did/name。',
    );
  }
  await writeCache(cacheFile(), {
    session,
    device,
    updatedAt: new Date().toISOString(),
  });
  log.info(`缓存写入 ${cacheFile()}（0600）：默认设备 ${device.name || device.did}`);
  log.info('下一步：node tools/probe.mjs status');
}

/**
 * Import an already signed-in browser session instead of logging in.
 * @param flags - Parsed command flags.
 */
async function commandSession(flags) {
  const cookie = typeof flags.cookie === 'string' ? parseCookieHeader(flags.cookie) : {};
  const serviceToken = (
    typeof flags['service-token'] === 'string' ? flags['service-token'] : process.env.XIAOMI_SERVICE_TOKEN ?? cookie.serviceToken ?? ''
  ).trim();
  const ssecurity = (
    typeof flags.ssecurity === 'string' ? flags.ssecurity : process.env.XIAOMI_SSECURITY ?? ''
  ).trim();
  const userId = (
    typeof flags['user-id'] === 'string' ? flags['user-id'] : process.env.XIAOMI_USER_ID ?? cookie.userId ?? ''
  ).trim();
  if (serviceToken === '' || ssecurity === '' || userId === '') {
    throw new Error(
      '用法：probe.mjs session --service-token <serviceToken> --ssecurity <ssecurity> --user-id <userId>\n'
      + '也可以只贴 Cookie：probe.mjs session --cookie "serviceToken=...; userId=..." --ssecurity ...',
    );
  }
  const session = sessionFromParts({ serviceToken, ssecurity, userId });
  log.info('使用浏览器会话（跳过账号密码与验证码）');
  try {
    await persistDevices(session);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (message.includes('401') || /auth error/i.test(message)) {
      throw new Error(
        '网页会话无效或已过期：请重新在浏览器登录，再复制 serviceToken / ssecurity / userId'
        + '（serviceToken 通常 30 天有效）。',
      );
    }
    throw error;
  }
}

/** List cached devices. */
async function commandList() {
  const cache = await readCache(cacheFile());
  if (cache === null) throw new Error(`没有缓存：${cacheFile()}`);
  console.log(JSON.stringify(cache.device ?? cache, null, 2));
}

/** Read the plug relay state. */
async function commandStatus(flags) {
  const plug = await plugFromCache(flags);
  const status = await plugStatus(plug);
  console.log(JSON.stringify(status, null, 2));
}

/**
 * Switch the relay.
 * @param flags - Parsed flags.
 * @param state - Target state.
 */
async function commandPower(flags, state) {
  const plug = await plugFromCache(flags);
  if (state === 'off' && flags.yes !== true) {
    throw new Error('off 会切断电脑电源，必须显式加 --yes 才会执行。');
  }
  const before = await plugStatus(plug);
  log.info(`before: ${before.power} (${before.model || 'unknown model'} @ ${before.host})`);
  const after = await plugPower(plug, state);
  log.info(`after: ${after}`);
}

/** Print usage. */
function usage() {
  console.log(`用法:
  node tools/probe.mjs session --service-token <t> --ssecurity <s> --user-id <u>
  node tools/probe.mjs session --cookie "serviceToken=...; userId=..." --ssecurity <s>
  node tools/probe.mjs login --user <账号> --password <密码>
  node tools/probe.mjs list
  node tools/probe.mjs status
  node tools/probe.mjs on
  node tools/probe.mjs off --yes
  node tools/probe.mjs status --host 192.168.8.x --token <32位token>`);
}

const [command = 'status', ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
try {
  switch (command) {
    case 'login':
      await commandLogin(flags);
      break;
    case 'session':
      await commandSession(flags);
      break;
    case 'list':
      await commandList();
      break;
    case 'status':
      await commandStatus(flags);
      break;
    case 'on':
      await commandPower(flags, 'on');
      break;
    case 'off':
      await commandPower(flags, 'off');
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      usage();
      process.exitCode = 2;
  }
} catch (error) {
  console.error(`[probe] 失败：${error instanceof Error ? error.message : String(error)}`);
  if (error?.details !== undefined) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
}
