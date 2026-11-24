/**
 * Xiaomi cloud account helper: sign in, then read the device list that carries
 * each device's LAN address and 32-hex miIO token.
 *
 * The password never leaves this module and is never logged. Callers should
 * keep the resulting session (service token + ssecurity) in a 0600 cache file
 * or the DSH credential store, and only pass the account password on the first
 * sign-in.
 *
 * The device API only accepts the miot encrypted-parameter scheme:
 *
 *   nonce       = base64(8 random bytes + minutes since the epoch)
 *   signedNonce = base64(sha256(base64decode(ssecurity) + base64decode(nonce)))
 *   signature   = base64(sha1("POST&/path&<sorted-free k=v pairs>&signedNonce"))
 *   every parameter value is RC4-encrypted with signedNonce and sent as a form
 *
 * The older plain HMAC signature is answered with HTTP 401 by current
 * firmware, so this module implements only the RC4 scheme.
 */

import crypto from 'node:crypto';

/** Account host. */
const ACCOUNT_HOST = 'https://account.xiaomi.com';
/** Device API host. */
const API_HOST = 'https://api.io.mi.com/app';
/** Mobile sign-in service used by the Mi Home app. */
const SID = 'xiaomiio';
/** Headers the Mi Home app sends; the API rejects some requests without them. */
const USER_AGENT = 'APP/com.xiaomi.mihome APPV/6.0.103';
/** User agent the device API expects (Mi Home for Android). */
const APP_USER_AGENT = 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-0123456789ab APP/xiaomi.smarthome APPV/62830';
/** Prefix Xiaomi puts in front of account JSON responses. */
const JSON_PREFIX = '&&&START&&&';
/** Default request timeout. */
const TIMEOUT_MS = 15000;

/**
 * A minimal cookie jar for one sign-in flow.
 */
class CookieJar {
  constructor(initial) {
    this.cookies = new Map();
    if (initial !== null && typeof initial === 'object') {
      for (const [name, value] of Object.entries(initial)) {
        if (typeof value === 'string') this.cookies.set(name, value);
      }
    }
  }

  /** @returns Plain cookie map for persistence. */
  toJSON() {
    return Object.fromEntries(this.cookies.entries());
  }

  /**
   * Absorb response cookies.
   * @param response - Fetch response.
   */
  absorb(response) {
    const rows = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
    for (const row of rows) {
      const pair = String(row).split(';', 1)[0];
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  /** @returns Cookie header value or an empty string. */
  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** @param name - Cookie name. @returns Value or undefined. */
  get(name) {
    return this.cookies.get(name);
  }
}

/** @param text - Response text. @returns Parsed JSON with the Xiaomi prefix removed. */
function parseXiaomiJson(text) {
  const body = text.startsWith(JSON_PREFIX) ? text.slice(JSON_PREFIX.length) : text;
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Xiaomi returned a non-JSON response (${body.slice(0, 120)})`);
  }
}

/** @param buffer - Bytes. @returns Base64 text. */
function b64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

/**
 * Build an RC4 stream for the miot encrypted-parameter scheme.
 * @param key - Decoded key bytes.
 * @returns Function encrypting one buffer.
 */
function rc4Stream(key) {
  const state = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) state[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + state[i] + key[i % key.length]) & 0xff;
    const swap = state[i];
    state[i] = state[j];
    state[j] = swap;
  }
  let i = 0;
  j = 0;
  return (data) => {
    const out = Buffer.alloc(data.length);
    for (let n = 0; n < data.length; n += 1) {
      i = (i + 1) & 0xff;
      j = (j + state[i]) & 0xff;
      const swap = state[i];
      state[i] = state[j];
      state[j] = swap;
      out[n] = data[n] ^ state[(state[i] + state[j]) & 0xff];
    }
    return out;
  };
}

/**
 * RC4-encrypt a UTF-8 string, discarding the first 1024 key-stream bytes the
 * way the Mi Home client does.
 * @param keyB64 - Base64 key.
 * @param text - Plain text.
 * @returns Base64 ciphertext.
 */
export function rc4Encrypt(keyB64, text) {
  const stream = rc4Stream(Buffer.from(keyB64, 'base64'));
  stream(Buffer.alloc(1024));
  return b64(stream(Buffer.from(text, 'utf8')));
}

/**
 * Decrypt one RC4 payload.
 * @param keyB64 - Base64 key.
 * @param payload - Base64 ciphertext.
 * @returns Plain text.
 */
export function rc4Decrypt(keyB64, payload) {
  const stream = rc4Stream(Buffer.from(keyB64, 'base64'));
  stream(Buffer.alloc(1024));
  return stream(Buffer.from(payload, 'base64')).toString('utf8');
}

/**
 * Generate the nonce used by the encrypted-parameter scheme: eight random
 * bytes plus the minutes since the epoch.
 * @returns Base64 nonce.
 */
export function genNonce() {
  const minutes = Math.trunc(Date.now() / 60000);
  const tail = [];
  let value = minutes;
  while (value > 0) {
    tail.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }
  if (tail.length === 0) tail.push(0);
  return b64(Buffer.concat([crypto.randomBytes(8), Buffer.from(tail)]));
}

/**
 * Derive the per-request key from ssecurity and the nonce.
 * @param ssecurity - Account security token (base64).
 * @param nonce - Request nonce (base64).
 * @returns Base64 signed nonce.
 */
export function signedNonce(ssecurity, nonce) {
  return b64(crypto.createHash('sha256').update(Buffer.concat([
    Buffer.from(ssecurity, 'base64'),
    Buffer.from(nonce, 'base64'),
  ])).digest());
}

/**
 * Sign the parameter set for the miot RC4 scheme.
 * @param method - HTTP method.
 * @param url - Full request URL.
 * @param nonceSigned - Signed nonce.
 * @param params - Parameter entries in insertion order.
 * @returns Base64 SHA-1 signature.
 */
export function encSignature(method, url, nonceSigned, params) {
  const path = url.split('com')[1].replace('/app/', '/');
  const parts = [method.toUpperCase(), path];
  for (const [key, value] of Object.entries(params)) parts.push(`${key}=${value}`);
  parts.push(nonceSigned);
  return b64(crypto.createHash('sha1').update(parts.join('&')).digest());
}

/**
 * Perform one encrypted POST against the device API.
 *
 * Current firmware rejects the older plain HMAC signature with 401 and only
 * accepts the RC4-encrypted parameter set (`MIOT-ENCRYPT-ALGORITHM`).
 *
 * @param options - Session, path, payload, and request timeout.
 * @returns Decoded JSON result body.
 */
async function encryptedPost({ session, path, payload, timeoutMs = TIMEOUT_MS }) {
  const url = `${API_HOST}${path}`;
  const params = { data: JSON.stringify(payload) };
  const nonce = genNonce();
  const nonceSigned = signedNonce(session.ssecurity, nonce);
  params.rc4_hash__ = encSignature('POST', url, nonceSigned, params);
  for (const key of Object.keys(params)) params[key] = rc4Encrypt(nonceSigned, params[key]);
  params.signature = encSignature('POST', url, nonceSigned, params);
  params.ssecurity = session.ssecurity;
  params._nonce = nonce;

  const headers = {
    'Accept-Encoding': 'identity',
    'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
    'Content-Type': 'application/x-www-form-urlencoded',
    'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
    'User-Agent': APP_USER_AGENT,
    Cookie: [
      `userId=${session.userId ?? ''}`,
      `yetAnotherServiceToken=${session.serviceToken}`,
      `serviceToken=${session.serviceToken}`,
      'locale=zh_CN',
      'timezone=Asia/Shanghai',
      'is_daylight=0',
      'dst_offset=0',
      'channel=MI_APP_STORE',
      'sdkVersion=3.8.6',
      `deviceId=${crypto.randomBytes(3).toString('hex')}`,
    ].join('; '),
  };
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Xiaomi device API HTTP ${response.status}: ${text.slice(0, 200)}`);
    error.httpStatus = response.status;
    throw error;
  }
  let body;
  try {
    body = JSON.parse(rc4Decrypt(nonceSigned, text));
  } catch {
    throw new Error(`Xiaomi device API returned an undecryptable payload: ${text.slice(0, 120)}`);
  }
  if (body?.code !== undefined && body.code !== 0) {
    throw new Error(`Xiaomi device API code ${body.code}: ${body.message ?? ''}`);
  }
  return body;
}

/**
 * Sign in with an account and password.
 * @param options - Username, password, locale, and request timeout.
 * @returns Session with service token, ssecurity, and user ids.
 */
export async function login({ username, password, icode = '', cookies, timeoutMs = TIMEOUT_MS }) {
  if (typeof username !== 'string' || username.trim() === '') throw new Error('Xiaomi account username is required');
  if (typeof password !== 'string' || password === '') throw new Error('Xiaomi account password is required');

  const jar = new CookieJar(cookies);
  const first = await fetch(`${ACCOUNT_HOST}/pass/serviceLogin?sid=${SID}&_json=true`, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  jar.absorb(first);

  const hash = crypto.createHash('md5').update(password, 'utf8').digest('hex').toUpperCase();
  const form = new URLSearchParams({
    user: username.trim(),
    hash,
    sid: SID,
    _json: 'true',
  });
  if (icode !== '') form.set('icode', icode.trim());
  const auth = await fetch(`${ACCOUNT_HOST}/pass/serviceLoginAuth2`, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar.header(),
    },
    body: form.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  jar.absorb(auth);
  const authText = await auth.text();
  const authBody = parseXiaomiJson(authText);

  if (authBody.code !== 0) {
    const error = new Error(describeLoginFailure(authBody));
    error.code = authBody.code;
    error.details = {
      code: authBody.code,
      description: authBody.description ?? authBody.desc ?? '',
      notificationUrl: authBody.notificationUrl ?? '',
      captchaUrl: authBody.captchaUrl ?? '',
      cookies: jar.toJSON(),
    };
    throw error;
  }
  if (typeof authBody.location !== 'string' || authBody.location === '') {
    throw new Error('Xiaomi sign-in succeeded without a redirect location');
  }

  const redirect = await fetch(authBody.location, {
    headers: { 'User-Agent': USER_AGENT, Cookie: jar.header() },
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  jar.absorb(redirect);
  const serviceToken = jar.get('serviceToken');
  if (typeof serviceToken !== 'string' || serviceToken === '') {
    throw new Error('Xiaomi sign-in did not return a serviceToken cookie');
  }

  return {
    username: username.trim(),
    userId: authBody.userId ?? jar.get('userId') ?? '',
    cUserId: authBody.cUserId ?? '',
    serviceToken,
    ssecurity: authBody.ssecurity ?? '',
    locale: authBody.locale ?? 'zh_CN',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Download the login captcha image for the current sign-in session.
 * @param options - Cookie map, captcha path, and destination file.
 * @returns Destination file path.
 */
export async function fetchCaptcha({ cookies, captchaUrl, file }) {
  const path = captchaUrl.startsWith('http') ? captchaUrl : `${ACCOUNT_HOST}${captchaUrl}`;
  const jar = new CookieJar(cookies);
  const response = await fetch(path, {
    headers: { 'User-Agent': USER_AGENT, Cookie: jar.header(), Accept: 'image/*' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`获取验证码图片失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const fs = await import('node:fs/promises');
  await fs.writeFile(file, bytes, { mode: 0o600 });
  return file;
}

/**
 * Turn a sign-in failure into a user-facing message.
 * @param body - Account response body.
 * @returns Message naming the required next step.
 */
function describeLoginFailure(body) {
  const description = String(body.description ?? body.desc ?? '').trim();
  if (body.code === 31005 || body.notificationUrl) {
    return `小米账号需要两步验证，请先完成验证：${body.notificationUrl ?? description}`;
  }
  if (body.code === 87001) {
    return '小米账号要求输入登录验证码：用 tools/probe.mjs login --icode <验证码> 完成（验证码图片会保存到本地）。';
  }
  if (body.code === 70016 || body.code === 70017) {
    return '小米账号或密码不正确。';
  }
  return `小米账号登录失败（code ${body.code}）：${description}`;
}

/**
 * Build a session from values copied out of an already signed-in browser.
 *
 * Completing the sign-in in a browser avoids the login captcha that the
 * command-line password flow can hit; the three values come from the
 * `serviceLoginAuth2` response (`ssecurity`) and the site's cookies
 * (`serviceToken`, `userId`).
 *
 * @param options - service token, ssecurity, and user id.
 * @returns Session object accepted by {@link listDevices}.
 */
export function sessionFromParts({ serviceToken, ssecurity, userId }) {
  const token = decodeCookieValue(String(serviceToken ?? '').trim());
  const security = decodeCookieValue(String(ssecurity ?? '').trim());
  const user = String(userId ?? '').trim();
  if (token === '') throw new Error('缺少 serviceToken（浏览器 Cookie 里的 serviceToken）');
  if (security === '') throw new Error('缺少 ssecurity（serviceLoginAuth2 响应里的 ssecurity）');
  if (user === '') throw new Error('缺少 userId（浏览器 Cookie 里的 userId）');
  return {
    username: '',
    userId: user,
    cUserId: '',
    serviceToken: token,
    ssecurity: security,
    createdAt: new Date().toISOString(),
    source: 'browser',
  };
}

/**
 * Decode a cookie value that may still be percent-encoded.
 * @param value - Raw value.
 * @returns Decoded value.
 */
function decodeCookieValue(value) {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse a browser cookie header into named values.
 * @param header - `serviceToken=...; userId=...` text.
 * @returns Cookie map.
 */
export function parseCookieHeader(header) {
  const map = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    map[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return map;
}

/**
 * List the account's devices, including LAN address and miIO token.
 * @param options - Session, page limit, and request timeout.
 * @returns Device rows normalized to the fields this plugin uses.
 */
export async function listDevices({ session, limit = 200 }) {
  const payload = { getVirtualModel: true, getHomeRoomInfo: false, limit };
  const body = await encryptedPost({ session, path: '/home/device_list', payload });

  const list = body?.result?.list;
  if (!Array.isArray(list)) throw new Error('Xiaomi device list is missing result.list');
  return list.map((row) => ({
    did: String(row.did ?? ''),
    name: String(row.name ?? ''),
    model: String(row.model ?? ''),
    host: String(row.localip ?? ''),
    token: String(row.token ?? ''),
    isOnline: Boolean(row.isOnline),
    mac: String(row.mac ?? ''),
  }));
}

/**
 * Read one MIoT property through the cloud.
 * @param options - Session, device id, and property ids.
 * @returns The property value, or undefined when the cloud does not report it.
 */
export async function cloudGetProperty({ session, did, siid, piid }) {
  const body = await encryptedPost({
    session,
    path: '/miotspec/prop/get',
    payload: { params: [{ did: String(did), siid, piid }] },
  });
  const rows = body?.result?.result ?? body?.result ?? [];
  const row = Array.isArray(rows) ? rows.find((item) => item?.siid === siid && item?.piid === piid) : undefined;
  return row?.value;
}

/**
 * Switch one MIoT property through the cloud.
 * @param options - Session, device id, property ids, and target value.
 * @returns The cloud result body.
 */
export async function cloudSetProperty({ session, did, siid, piid, value }) {
  return encryptedPost({
    session,
    path: '/miotspec/prop/set',
    payload: { params: [{ did: String(did), siid, piid, value }] },
  });
}

/**
 * Pick the plug this plugin should drive.
 * @param devices - Rows from {@link listDevices}.
 * @param selector - Optional did, model, or name filter.
 * @returns The selected row.
 */
export function selectPlug(devices, selector = {}) {
  const { did, model, name } = selector;
  const matches = devices.filter((device) => {
    if (did && device.did !== did) return false;
    if (model && !device.model.includes(model)) return false;
    if (name && !device.name.includes(name)) return false;
    return true;
  });
  if (matches.length === 0) {
    throw new Error(`没有找到匹配的插座设备（selector ${JSON.stringify(selector)}）`);
  }
  if (matches.length > 1) {
    const names = matches.map((device) => `${device.name || '(未命名)'} ${device.model} ${device.did}`).join('；');
    throw new Error(`匹配到多个设备，请在配置里指定 did 或更精确的 name：${names}`);
  }
  return matches[0];
}

/**
 * Mask a token for logs and diagnostics.
 * @param token - Plain token.
 * @returns Masked token.
 */
export function maskToken(token) {
  const text = String(token ?? '');
  if (text.length <= 8) return '***';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}
