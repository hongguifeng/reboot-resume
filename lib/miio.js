/**
 * Minimal miIO client for Wi-Fi devices (Xiaomi smart plugs).
 *
 * The protocol is a 16-byte header followed by a 16-byte MD5 checksum and, for
 * commands, AES-128-CBC encrypted JSON:
 *
 *   magic    2  0x2131 handshake, 0x2132 encrypted command
 *   length   2  total packet length
 *   unknown  4  echoed by the device
 *   deviceId 4  0xffffffff for a handshake request
 *   stamp    4  echoed by the device (unix seconds for commands)
 *   checksum16  MD5(header + token)
 *   data        AES-128-CBC(json, MD5(token), MD5(MD5(token) + token))
 *
 * The device stays reachable while its relay is off, which is what makes a
 * smart plug usable for a cold boot: the plug itself is powered from the wall,
 * only the load is switched.
 *
 * This module has no dependencies and never logs a token.
 */

import crypto from 'node:crypto';
import dgram from 'node:dgram';

/** Every miIO packet starts with this magic, encrypted or not. */
const MAGIC = 0x2131;
/** Default miIO port. */
export const MIIO_PORT = 54321;
/** Largest packet accepted from a device. */
const MAX_PACKET = 4096;

/**
 * Normalize a device token.
 * @param token - 32 hex characters, optionally separated by `:` or spaces.
 * @returns Lowercase hex token.
 */
export function normalizeToken(token) {
  const clean = String(token ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (clean.length !== 32) {
    throw new Error(`miIO token must be 32 hex characters, got ${clean.length}`);
  }
  return clean;
}

/** @param value - Input buffer. @returns MD5 digest. */
function md5(value) {
  return crypto.createHash('md5').update(value).digest();
}

/** @param token - Normalized hex token. @returns AES key. */
function keyOf(token) {
  return md5(Buffer.from(token, 'hex'));
}

/** @param token - Normalized hex token. @returns AES initialization vector. */
function ivOf(token) {
  return md5(Buffer.concat([keyOf(token), Buffer.from(token, 'hex')]));
}

/**
 * Build the unauthenticated handshake used to learn a device id and stamp.
 * @returns Packet buffer.
 */
export function handshakePacket() {
  const header = Buffer.alloc(16);
  header.writeUInt16BE(MAGIC, 0);
  header.writeUInt16BE(32, 2);
  header.writeUInt32BE(0xffffffff, 4);
  header.writeUInt32BE(0xffffffff, 8);
  header.writeUInt32BE(0xffffffff, 12);
  // The reference client sends an all-ones checksum here; devices ignore it.
  return Buffer.concat([header, Buffer.alloc(16, 0xff)]);
}

/**
 * Parse a packet header.
 * @param packet - Raw datagram.
 * @returns Header fields and body.
 */
export function parsePacket(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 32) {
    throw new Error('miIO packet is too short');
  }
  const header = {
    magic: packet.readUInt16BE(0),
    length: packet.readUInt16BE(2),
    unknown: packet.readUInt32BE(4),
    deviceId: packet.readUInt32BE(8),
    stamp: packet.readUInt32BE(12),
    checksum: packet.subarray(16, 32),
    body: packet.subarray(32),
  };
  if (header.magic !== MAGIC) {
    throw new Error(`unknown miIO magic 0x${header.magic.toString(16)}`);
  }
  if (header.length !== packet.length) {
    throw new Error(`miIO length ${header.length} does not match ${packet.length}`);
  }
  return header;
}

/**
 * Verify a packet checksum against the token.
 * @param header - Parsed header from {@link parsePacket}.
 * @param packet - Raw datagram.
 * @param token - Normalized hex token.
 * @returns Whether the checksum matches.
 */
export function verifyChecksum(header, packet, token) {
  // The device signs header + token + ciphertext, not just the header.
  const expected = md5(Buffer.concat([packet.subarray(0, 16), Buffer.from(token, 'hex'), header.body]));
  return expected.equals(header.checksum);
}

/**
 * Encrypt one command into an encrypted packet.
 * @param params - Device address, token, device id, stamp, and JSON payload.
 * @returns Packet buffer.
 */
export function encryptPacket({ token, deviceId, stamp, payload }) {
  const cipher = crypto.createCipheriv('aes-128-cbc', keyOf(token), ivOf(token));
  const data = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final(),
  ]);
  const header = Buffer.alloc(16);
  header.writeUInt16BE(MAGIC, 0);
  header.writeUInt16BE(32 + data.length, 2);
  header.writeUInt32BE(0, 4);
  header.writeUInt32BE(deviceId >>> 0, 8);
  header.writeUInt32BE(stamp >>> 0, 12);
  const checksum = md5(Buffer.concat([header, Buffer.from(token, 'hex'), data]));
  return Buffer.concat([header, checksum, data]);
}

/**
 * Decrypt an encrypted packet body.
 * @param header - Parsed header from {@link parsePacket}.
 * @param token - Normalized hex token.
 * @returns Parsed JSON payload.
 */
export function decryptPacket(header, token) {
  if (header.body.length % 16 !== 0 || header.body.length === 0) {
    throw new Error('miIO encrypted body has an invalid length');
  }
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyOf(token), ivOf(token));
  const plain = Buffer.concat([decipher.update(header.body), decipher.final()]);
  const text = plain.toString('utf8').replace(/\0+$/, '');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('miIO reply is not valid JSON');
  }
}

/**
 * Send one datagram and await one reply.
 * @param options - Host, port, packet, timeout, and an optional reply filter.
 * @returns Reply buffer.
 */
function exchange({ host, port, packet, timeoutMs, accept }) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Closing an already closed socket is not an error here.
      }
      if (error !== null) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`miIO timeout after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();

    socket.on('error', (error) => finish(error));
    socket.on('message', (message) => {
      if (message.length > MAX_PACKET) return;
      if (accept !== undefined && !accept(message)) return;
      finish(null, message);
    });
    socket.send(packet, port, host, (error) => {
      if (error !== null && error !== undefined) finish(error);
    });
  });
}

/**
 * Perform a handshake and return the device identity.
 * @param options - Host, port, and timeout.
 * @returns Device id (unsigned 32-bit) and stamp.
 */
export async function hello({ host, port = MIIO_PORT, timeoutMs = 3000 }) {
  const reply = await exchange({
    host,
    port,
    packet: handshakePacket(),
    timeoutMs,
    accept: (message) => message.length >= 32 && message.readUInt16BE(0) === MAGIC,
  });
  const header = parsePacket(reply);
  if (header.deviceId === 0xffffffff) {
    throw new Error('miIO handshake returned the broadcast id');
  }
  return { deviceId: header.deviceId, stamp: header.stamp };
}

/**
 * A connected plug: handshake done once, commands reuse the device id.
 */
export class MiioPlug {
  /**
   * @param options - Host, token, optional port and timeouts.
   */
  constructor({ host, token, port = MIIO_PORT, timeoutMs = 4000 }) {
    if (typeof host !== 'string' || host === '') throw new Error('miIO host is required');
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.token = normalizeToken(token);
    this.deviceId = 0xffffffff;
    this.deviceStamp = 0;
    this.handshakeAt = 0;
    this.sequence = 0;
  }

  /**
   * Learn the device id if it is not known yet.
   * @returns Device id.
   */
  async connect() {
    if (this.deviceId !== 0xffffffff) return this.deviceId;
    const identity = await hello({ host: this.host, port: this.port, timeoutMs: this.timeoutMs });
    this.deviceId = identity.deviceId;
    // The device keeps its own clock (often uptime seconds) and drops packets
    // whose stamp is far from it, so commands continue the handshake stamp.
    this.deviceStamp = identity.stamp;
    this.handshakeAt = Date.now();
    return this.deviceId;
  }

  /**
   * Current stamp in the device's clock.
   * @returns Stamp for the next command.
   */
  stamp() {
    const elapsed = Math.max(0, Math.floor((Date.now() - this.handshakeAt) / 1000));
    return (this.deviceStamp + elapsed) >>> 0;
  }

  /**
   * Run one miIO method.
   * @param method - Method name, such as `get_prop`.
   * @param params - Method parameters.
   * @returns The `result` field of the reply.
   */
  async call(method, params = []) {
    await this.connect();
    const id = ++this.sequence;
    const stamp = this.stamp();
    const packet = encryptPacket({
      token: this.token,
      deviceId: this.deviceId,
      stamp,
      payload: { id, method, params },
    });
    const reply = await exchange({
      host: this.host,
      port: this.port,
      packet,
      timeoutMs: this.timeoutMs,
      accept: (message) => message.length > 32 && message.readUInt16BE(0) === MAGIC,
    });
    const header = parsePacket(reply);
    if (header.deviceId !== this.deviceId && this.deviceId !== 0xffffffff) {
      throw new Error('miIO reply came from a different device id');
    }
    if (!verifyChecksum(header, reply, this.token)) {
      throw new Error('miIO reply checksum mismatch (wrong token?)');
    }
    const payload = decryptPacket(header, this.token);
    if (payload?.id !== undefined && payload.id !== id) {
      throw new Error('miIO reply id does not match the request');
    }
    if (payload?.error !== undefined) {
      throw new Error(`miIO error: ${JSON.stringify(payload.error)}`);
    }
    return payload?.result;
  }

  /**
   * Read the relay state.
   * @returns `'on'`, `'off'`, or an empty string when the device reports nothing.
   */
  async power() {
    const result = await this.call('get_prop', ['power']);
    const value = Array.isArray(result) ? result[0] : undefined;
    return typeof value === 'string' ? value : '';
  }

  /**
   * Switch the relay.
   * @param state - `'on'` or `'off'`.
   * @returns The device result.
   */
  async setPower(state) {
    if (state !== 'on' && state !== 'off') throw new Error(`invalid power state ${String(state)}`);
    const result = await this.call('set_power', [state]);
    return result;
  }

  /**
   * Read device information.
   * @returns Model, firmware, and hardware fields reported by the device.
   */
  async info() {
    const result = await this.call('miIO.info', []);
    return result !== null && typeof result === 'object' ? result : {};
  }
}
