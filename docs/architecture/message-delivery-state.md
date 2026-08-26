# Agent message delivery state

Agent-to-agent delivery is file-backed. The authoritative records live under
the instance root (`~/.cortextos/<instance>` by default):

- `inbox/<agent>/`: queued, not yet injected
- `inflight/<agent>/`: injected and awaiting an agent ACK
- `processed/<agent>/`: ACKed or retry-exhausted audit records
- `state/<agent>/message-acks/`: short-lived durable ACK receipts used to
  reconcile queue-move and process-crash races

The dashboard SQLite database is a read model. Its `messages` table has no
delivery or ACK columns and is not read by the daemon to decide redelivery.

## Delivery and ACK contract

`checkInbox()` moves a queued record to `inflight/` before returning it for
injection. The daemon does not auto-ACK at injection time, because doing so can
lose a message when bytes reach a wedged PTY but the agent never processes the
turn. After successful PTY injection the daemon adds
`injection_confirmed_at`; only confirmed deliveries qualify for the longer
active-turn lease. A failed injection or daemon crash before confirmation stays
on the ordinary five-minute recovery path. A paste whose delayed Enter fails is
also a failed injection; it is never confirmed as delivered.

The receiving agent ACKs in either of two ways:

1. `send-message ... <reply_to>` durably auto-ACKs the original message.
2. `ack-inbox <message_id>` explicitly ACKs a message that needs no reply.

An ACK first writes a receipt, then reconciles matching records from any of
`inbox/`, `inflight/`, or `processed/`. The processed record is annotated with
`acknowledged: true` and `acked_at`. On each inbox poll, receipts are reconciled
before stale recovery, so an ACK survives daemon restart and cannot lose a race
with a queue move. Receipts remain as a short crash-recovery horizon and expire
after seven days; keeping them briefly also protects against an unpersisted
source-file unlink after sudden host power loss. ACK receipt and processed-record
writes include file and parent-directory `fsync` barriers on Unix-like hosts,
and removing the source queue record durably syncs that source directory too.
Receipt I/O and validation are fail-closed during polling: only `ENOENT` means
"no ACK"; an explicit new ACK can safely replace a malformed receipt.
ACK receipt creation and PTY submission share the inbox mutex, so an ACK that
wins the lock filters the selected message before injection; if delivery wins,
the later ACK legitimately acknowledges that completed submission.

## Bounded redelivery

An un-ACK'd idle delivery becomes eligible for retry after five minutes. A
delivery whose agent turn is still active is leased for at most 30 minutes, and
a just-completed turn gets a five-minute ACK grace. This prevents a long tool
run from receiving the same queued prompt every five minutes while preserving
recovery for abandoned or wedged work.

Every stale recovery increments `redeliveries`. After three redeliveries, the
next recovery parks the record in `processed/` with
`redelivery_exhausted: true` and emits a loud daemon error. This is the final
backstop against an infinite delivery loop.

## Operational reconciliation

Do not edit live queue files or dashboard SQLite rows manually. Use
`ack-inbox <message_id>`; it is idempotent and can reconcile queued, inflight,
and retry-exhausted records safely while the daemon is running. Code changes to
this state machine require the normal reviewed merge and coordinated daemon
restart before they affect the live fleet.
