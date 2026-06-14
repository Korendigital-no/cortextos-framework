import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import {
  createHash,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from 'crypto';
import type { InboxMessage, BusMessageSignature, BusPaths } from '../types/index.js';
import { ensureDir } from '../utils/atomic.js';
import { validateAgentName } from '../utils/validate.js';

const ALG = 'Ed25519';

function keyPaths(ctxRoot: string, agent: string): { privateKey: string; publicKey: string } {
  validateAgentName(agent);
  const dir = join(ctxRoot, 'state', agent, 'bus-signing');
  return {
    privateKey: join(dir, 'ed25519-private.pem'),
    publicKey: join(dir, 'ed25519-public.pem'),
  };
}

function keyId(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16);
}

function canonicalPayload(msg: Omit<InboxMessage, 'signature' | 'sig'>): string {
  return JSON.stringify({
    id: msg.id,
    from: msg.from,
    to: msg.to,
    priority: msg.priority,
    timestamp: msg.timestamp,
    text: msg.text,
    reply_to: msg.reply_to,
  });
}

function ensureSigningKeypair(ctxRoot: string, agent: string): { privateKeyPem: string; publicKeyPem: string } {
  const paths = keyPaths(ctxRoot, agent);
  if (existsSync(paths.privateKey) && existsSync(paths.publicKey)) {
    return {
      privateKeyPem: readFileSync(paths.privateKey, 'utf-8'),
      publicKeyPem: readFileSync(paths.publicKey, 'utf-8'),
    };
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  ensureDir(join(ctxRoot, 'state', agent, 'bus-signing'));
  writeFileSync(paths.privateKey, privateKeyPem, { encoding: 'utf-8', mode: 0o600 });
  writeFileSync(paths.publicKey, publicKeyPem, { encoding: 'utf-8', mode: 0o644 });
  chmodSync(paths.publicKey, 0o644);
  return { privateKeyPem, publicKeyPem };
}

function readPublicKey(ctxRoot: string, agent: string): string | null {
  try {
    const paths = keyPaths(ctxRoot, agent);
    return readFileSync(paths.publicKey, 'utf-8');
  } catch {
    return null;
  }
}

export function signInboxMessage(paths: BusPaths, msg: Omit<InboxMessage, 'signature' | 'sig'>): InboxMessage {
  const { privateKeyPem, publicKeyPem } = ensureSigningKeypair(paths.ctxRoot, msg.from);
  const payload = canonicalPayload(msg);
  const signature: BusMessageSignature = {
    alg: ALG,
    signer: msg.from,
    key_id: keyId(publicKeyPem),
    signature: edSign(null, Buffer.from(payload), privateKeyPem).toString('base64'),
  };
  return { ...msg, signature };
}

export type VerificationStatus =
  | 'valid'
  | 'unsigned'
  | 'missing-public-key'
  | 'unsupported-alg'
  | 'wrong-signer'
  | 'bad-key-id'
  | 'invalid';

export interface VerificationResult {
  status: VerificationStatus;
  accepted: true;
}

export function verifyInboxMessage(ctxRoot: string, msg: InboxMessage): VerificationResult {
  const signature = msg.signature;
  if (!signature) return { status: 'unsigned', accepted: true };
  if (signature.alg !== ALG) return { status: 'unsupported-alg', accepted: true };
  if (signature.signer !== msg.from) return { status: 'wrong-signer', accepted: true };

  const publicKeyPem = readPublicKey(ctxRoot, msg.from);
  if (!publicKeyPem) return { status: 'missing-public-key', accepted: true };
  if (signature.key_id !== keyId(publicKeyPem)) return { status: 'bad-key-id', accepted: true };

  const { signature: _sig, sig: _legacySig, ...unsignedMsg } = msg;
  try {
    const ok = edVerify(
      null,
      Buffer.from(canonicalPayload(unsignedMsg)),
      publicKeyPem,
      Buffer.from(signature.signature, 'base64'),
    );
    return { status: ok ? 'valid' : 'invalid', accepted: true };
  } catch {
    return { status: 'invalid', accepted: true };
  }
}

export function logSignatureShadow(paths: BusPaths, msg: InboxMessage, result: VerificationResult): void {
  if (result.status === 'valid') return;
  try {
    ensureDir(paths.logDir);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: 'bus_signature_shadow',
      status: result.status,
      accepted: result.accepted,
      msg_id: msg.id,
      from: msg.from,
      to: msg.to,
    });
    appendFileSync(join(paths.logDir, 'bus-signature-shadow.jsonl'), line + '\n', 'utf-8');
  } catch {
    // Shadow observability must never affect bus delivery.
  }
}

export const __test__ = {
  canonicalPayload,
  keyId,
};
