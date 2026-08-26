import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, checkInbox, ackInbox, withInboxDeliveryLock } from '../../../src/bus/message';
import { verifyInboxMessage } from '../../../src/bus/message-signing';
import { resolvePaths } from '../../../src/utils/paths';
import type { BusPaths, InboxMessage } from '../../../src/types';

describe('Message Bus', () => {
  let testDir: string;
  let senderPaths: BusPaths;
  let receiverPaths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-bus-test-'));
    // Override ctxRoot to use temp directory
    senderPaths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'sender'),
      inflight: join(testDir, 'inflight', 'sender'),
      processed: join(testDir, 'processed', 'sender'),
      logDir: join(testDir, 'logs', 'sender'),
      stateDir: join(testDir, 'state', 'sender'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    receiverPaths = {
      ...senderPaths,
      inbox: join(testDir, 'inbox', 'receiver'),
      inflight: join(testDir, 'inflight', 'receiver'),
      processed: join(testDir, 'processed', 'receiver'),
      logDir: join(testDir, 'logs', 'receiver'),
      stateDir: join(testDir, 'state', 'receiver'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('sendMessage', () => {
    it('creates a JSON file in receiver inbox', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'Hello');
      expect(msgId).toBeTruthy();

      const receiverInbox = join(testDir, 'inbox', 'receiver');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(1);

      // Verify filename format: {pnum}-{epochMs}-from-{sender}-{rand5}.json
      expect(files[0]).toMatch(/^2-\d+-from-sender-[a-z0-9]{5}\.json$/);
    });

    it('produces JSON matching bash format', () => {
      sendMessage(senderPaths, 'paul', 'boris', 'high', 'Build the page');

      const receiverInbox = join(testDir, 'inbox', 'boris');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      const content = JSON.parse(readFileSync(join(receiverInbox, files[0]), 'utf-8'));

      // Verify all fields match bash send-message.sh format
      expect(content).toHaveProperty('id');
      expect(content).toHaveProperty('from', 'paul');
      expect(content).toHaveProperty('to', 'boris');
      expect(content).toHaveProperty('priority', 'high');
      expect(content).toHaveProperty('timestamp');
      expect(content).toHaveProperty('text', 'Build the page');
      expect(content).toHaveProperty('reply_to', null);
      expect(content).toHaveProperty('signature');
      expect(content.signature).toMatchObject({
        alg: 'Ed25519',
        signer: 'paul',
      });

      // Verify filename has priority 1 (high)
      expect(files[0]).toMatch(/^1-/);
    });

    it('creates a per-agent Ed25519 keypair and signs new messages', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'Signed hello');

      const receiverInbox = join(testDir, 'inbox', 'receiver');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      const msg = JSON.parse(readFileSync(join(receiverInbox, files[0]), 'utf-8')) as InboxMessage;

      const privateKeyPath = join(testDir, 'state', 'sender', 'bus-signing', 'ed25519-private.pem');
      const publicKeyPath = join(testDir, 'state', 'sender', 'bus-signing', 'ed25519-public.pem');
      expect(existsSync(privateKeyPath)).toBe(true);
      expect(existsSync(publicKeyPath)).toBe(true);
      expect(statSync(publicKeyPath).mode & 0o777).toBe(0o644);
      expect(verifyInboxMessage(testDir, msg).status).toBe('valid');
    });

    it('encodes priority correctly in filename', () => {
      sendMessage(senderPaths, 'a', 'b', 'urgent', 'test');
      sendMessage(senderPaths, 'a', 'b', 'high', 'test');
      sendMessage(senderPaths, 'a', 'b', 'normal', 'test');
      sendMessage(senderPaths, 'a', 'b', 'low', 'test');

      const inbox = join(testDir, 'inbox', 'b');
      const files = readdirSync(inbox).filter(f => f.endsWith('.json')).sort();

      expect(files[0]).toMatch(/^0-/); // urgent
      expect(files[1]).toMatch(/^1-/); // high
      expect(files[2]).toMatch(/^2-/); // normal
      expect(files[3]).toMatch(/^3-/); // low
    });

    it('rejects invalid agent names', () => {
      expect(() =>
        sendMessage(senderPaths, '../bad', 'good', 'normal', 'test')
      ).toThrow();
    });
  });

  describe('checkInbox', () => {
    it('returns empty array for empty inbox', () => {
      const messages = checkInbox(receiverPaths);
      expect(messages).toEqual([]);
    });

    it('returns messages sorted by priority', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'low', 'low priority');
      sendMessage(senderPaths, 'sender', 'receiver', 'urgent', 'urgent');
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'normal');

      const messages = checkInbox(receiverPaths);
      expect(messages.length).toBe(3);
      expect(messages[0].priority).toBe('urgent');
      expect(messages[1].priority).toBe('normal');
      expect(messages[2].priority).toBe('low');
    });

    it('moves messages to inflight', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      checkInbox(receiverPaths);

      const inboxFiles = readdirSync(receiverPaths.inbox).filter(f => f.endsWith('.json'));
      const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));

      expect(inboxFiles.length).toBe(0);
      expect(inflightFiles.length).toBe(1);
    });

    it('accepts unsigned legacy messages and records shadow observability', () => {
      mkdirSync(receiverPaths.inbox, { recursive: true });
      const legacy: InboxMessage = {
        id: 'legacy-1',
        from: 'mike',
        to: 'receiver',
        priority: 'normal',
        timestamp: '2026-06-14T00:00:00.000Z',
        text: 'unsigned legacy',
        reply_to: null,
      };
      writeFileSync(join(receiverPaths.inbox, '2-1780000000000-from-mike-abcde.json'), JSON.stringify(legacy));

      const messages = checkInbox(receiverPaths);

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('legacy-1');
      const log = readFileSync(join(receiverPaths.logDir, 'bus-signature-shadow.jsonl'), 'utf-8');
      expect(log).toContain('"status":"unsigned"');
      expect(log).toContain('"accepted":true');
    });

    it('accepts tampered signed messages in shadow and logs invalid instead of rejecting', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'original');
      const receiverInbox = join(testDir, 'inbox', 'receiver');
      const file = readdirSync(receiverInbox).find(f => f.endsWith('.json'));
      if (!file) throw new Error('expected inbox file');
      const filePath = join(receiverInbox, file);
      const msg = JSON.parse(readFileSync(filePath, 'utf-8')) as InboxMessage;
      msg.text = 'tampered after signing';
      writeFileSync(filePath, JSON.stringify(msg));

      const messages = checkInbox(receiverPaths);

      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('tampered after signing');
      expect(readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'))).toHaveLength(1);
      const log = readFileSync(join(receiverPaths.logDir, 'bus-signature-shadow.jsonl'), 'utf-8');
      expect(log).toContain('"status":"invalid"');
      expect(log).toContain('"accepted":true');
    });

    it('accepts signed messages with missing sender public key in shadow', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'signed but key unavailable');
      rmSync(join(testDir, 'state', 'sender', 'bus-signing', 'ed25519-public.pem'), { force: true });

      const messages = checkInbox(receiverPaths);

      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('signed but key unavailable');
      const log = readFileSync(join(receiverPaths.logDir, 'bus-signature-shadow.jsonl'), 'utf-8');
      expect(log).toContain('"status":"missing-public-key"');
      expect(log).toContain('"accepted":true');
    });
  });

  describe('ackInbox', () => {
    it('moves message from inflight to processed', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      checkInbox(receiverPaths); // moves to inflight

      ackInbox(receiverPaths, msgId);

      const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));
      const processedFiles = readdirSync(receiverPaths.processed).filter(f => f.endsWith('.json'));

      expect(inflightFiles.length).toBe(0);
      expect(processedFiles.length).toBe(1);

      const processed = JSON.parse(readFileSync(join(receiverPaths.processed, processedFiles[0]), 'utf-8'));
      expect(processed.acknowledged).toBe(true);
      expect(processed.acked_at).toEqual(expect.any(String));
    });

    it('acks a recovered message from inbox before it can be delivered again', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');

      ackInbox(receiverPaths, msgId);

      expect(readdirSync(receiverPaths.inbox).filter(f => f.endsWith('.json'))).toHaveLength(0);
      expect(readdirSync(receiverPaths.processed).filter(f => f.endsWith('.json'))).toHaveLength(1);
      expect(checkInbox(receiverPaths)).toEqual([]);
    });

    it('reconciles a late ACK against an exhausted processed record', () => {
      mkdirSync(receiverPaths.processed, { recursive: true });
      const filename = '2-1780000000000-from-sender-abcde.json';
      writeFileSync(join(receiverPaths.processed, filename), JSON.stringify({
        id: 'late-ack',
        from: 'sender',
        to: 'receiver',
        priority: 'normal',
        timestamp: '2026-08-25T10:00:00.000Z',
        text: 'already parked',
        reply_to: null,
        redeliveries: 4,
        redelivery_exhausted: true,
      }));

      ackInbox(receiverPaths, 'late-ack');

      const processed = JSON.parse(readFileSync(join(receiverPaths.processed, filename), 'utf-8'));
      expect(processed.acknowledged).toBe(true);
      expect(processed.acked_at).toEqual(expect.any(String));
      expect(processed.redelivery_exhausted).toBe(true);
    });

    it('persists an ACK receipt so a racing message cannot redeliver after restart', () => {
      // Simulate the lock-timeout/race edge: ACK becomes durable just before
      // the authoritative queue file is visible to the ACK scan.
      ackInbox(receiverPaths, 'racing-ack');

      mkdirSync(receiverPaths.inbox, { recursive: true });
      const filename = '2-1780000000001-from-sender-fghij.json';
      writeFileSync(join(receiverPaths.inbox, filename), JSON.stringify({
        id: 'racing-ack',
        from: 'sender',
        to: 'receiver',
        priority: 'normal',
        timestamp: '2026-08-25T10:00:01.000Z',
        text: 'must be reconciled, never delivered',
        reply_to: null,
      }));

      expect(checkInbox(receiverPaths)).toEqual([]);
      expect(readdirSync(receiverPaths.inbox).filter(f => f.endsWith('.json'))).toHaveLength(0);
      const processed = JSON.parse(readFileSync(join(receiverPaths.processed, filename), 'utf-8'));
      expect(processed.acknowledged).toBe(true);
      expect(processed.acked_at).toEqual(expect.any(String));
    });

    it('reconciles a receipt into a processed record that appears after the ACK', () => {
      ackInbox(receiverPaths, 'parked-race-ack');

      mkdirSync(receiverPaths.processed, { recursive: true });
      const filename = '2-1780000000002-from-sender-klmno.json';
      writeFileSync(join(receiverPaths.processed, filename), JSON.stringify({
        id: 'parked-race-ack',
        from: 'sender',
        to: 'receiver',
        priority: 'normal',
        timestamp: '2026-08-25T10:00:02.000Z',
        text: 'parked after ACK scan raced recovery',
        reply_to: null,
        redeliveries: 4,
        redelivery_exhausted: true,
      }));

      expect(checkInbox(receiverPaths)).toEqual([]);
      const processed = JSON.parse(readFileSync(join(receiverPaths.processed, filename), 'utf-8'));
      expect(processed.acknowledged).toBe(true);
      expect(processed.acked_at).toEqual(expect.any(String));
      expect(processed.redelivery_exhausted).toBe(true);
    });

    it('fails closed on a corrupt matching receipt and lets explicit ACK repair it', () => {
      ackInbox(receiverPaths, 'corrupt-receipt-ack');
      const receiptDir = join(receiverPaths.stateDir, 'message-acks');
      const receiptFile = readdirSync(receiptDir).find(f => f.endsWith('.json'));
      if (!receiptFile) throw new Error('expected ACK receipt');
      writeFileSync(join(receiptDir, receiptFile), '{not-json');

      mkdirSync(receiverPaths.inbox, { recursive: true });
      const filename = '2-1780000000003-from-sender-pqrst.json';
      writeFileSync(join(receiverPaths.inbox, filename), JSON.stringify({
        id: 'corrupt-receipt-ack',
        from: 'sender',
        to: 'receiver',
        priority: 'normal',
        timestamp: '2026-08-25T10:00:03.000Z',
        text: 'must not redeliver through a corrupt receipt',
        reply_to: null,
      }));

      expect(() => checkInbox(receiverPaths)).toThrow(/Malformed ACK receipt/);
      expect(readdirSync(receiverPaths.inbox).filter(f => f.endsWith('.json'))).toHaveLength(1);

      expect(ackInbox(receiverPaths, 'corrupt-receipt-ack')).toBe('acked');
      expect(checkInbox(receiverPaths)).toEqual([]);
      const processed = JSON.parse(readFileSync(join(receiverPaths.processed, filename), 'utf-8'));
      expect(processed.acknowledged).toBe(true);
    });

    it('treats valid JSON null as repairable invalid receipt data', () => {
      ackInbox(receiverPaths, 'null-receipt-ack');
      const receiptDir = join(receiverPaths.stateDir, 'message-acks');
      const receiptFile = readdirSync(receiptDir).find(f => f.endsWith('.json'));
      if (!receiptFile) throw new Error('expected ACK receipt');
      writeFileSync(join(receiptDir, receiptFile), 'null');

      expect(() => ackInbox(receiverPaths, 'null-receipt-ack')).not.toThrow();
    });

    it('filters a message ACKed after selection but before delivery lock acquisition', async () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'stale selection');
      const selected = checkInbox(receiverPaths);
      expect(selected).toHaveLength(1);

      ackInbox(receiverPaths, msgId);

      const delivered = await withInboxDeliveryLock(receiverPaths, selected, async eligible => eligible);
      expect(delivered).toEqual([]);
    });
  });
});
