import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CursorExecutor,
  newStreamCtx,
  cursorStreamProgress,
} from "../../open-sse/executors/cursor";

// ─── Wire-format helpers (mirror cursor-streaming.test.ts) ──────────────────

function v(n: number): Buffer {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}
function lenPrefixed(field: number, payload: Buffer): Buffer {
  return Buffer.concat([v((field << 3) | 2), v(payload.length), payload]);
}
function buildTextDeltaPayload(text: string): Buffer {
  return lenPrefixed(1, lenPrefixed(1, lenPrefixed(1, Buffer.from(text, "utf8"))));
}
function buildTurnEndedPayload(): Buffer {
  return lenPrefixed(1, lenPrefixed(14, Buffer.alloc(0)));
}
// AgentServerMessage { kv_server_message (4): {} } — carries no model output.
function buildKvServerMessagePayload(): Buffer {
  return lenPrefixed(4, Buffer.alloc(0));
}
// Connect-RPC envelope: 1-byte flags + 4-byte big-endian length + payload.
function frame(payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function fakeH2() {
  const req = Object.assign(new EventEmitter(), {
    closed: false,
    write() {
      return true;
    },
    close() {
      req.closed = true;
    },
  });
  const client = { close() {} };
  return { req, client, initialBytes: Buffer.alloc(0) };
}

type DriveH2 = (
  h2: ReturnType<typeof fakeH2>,
  ctx: ReturnType<typeof newStreamCtx>,
  mcpTools: undefined,
  blobStore: undefined,
  clientPlatform: undefined,
  todoHistory: undefined,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number
) => Promise<void>;

function drive(h2: ReturnType<typeof fakeH2>, idleTimeoutMs: number, emit = () => {}) {
  const exec = new CursorExecutor();
  const driveH2 = (exec as unknown as { driveH2: DriveH2 }).driveH2.bind(exec);
  const ctx = newStreamCtx("auto-balance", emit);
  return {
    ctx,
    done: driveH2(h2, ctx, undefined, undefined, undefined, undefined, undefined, idleTimeoutMs),
  };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Tests ─────────────────────────────────────────────────────────────────

test("cursorStreamProgress changes when text is accumulated", () => {
  const ctx = newStreamCtx("auto-balance", () => {});
  const before = cursorStreamProgress(ctx);
  ctx.totalText += "hi";
  assert.notEqual(cursorStreamProgress(ctx), before);
});

test("driveH2 aborts a stream that produces no model output within the idle timeout", async () => {
  const h2 = fakeH2();
  const { done } = drive(h2, 40);
  await assert.rejects(done, /cursor-agent stream timed out \(no model output for 40ms\)/);
  assert.equal(h2.req.closed, true, "stalled h2 stream must be torn down");
});

test("driveH2 aborts when the upstream goes silent after partial output (mid-stream stall)", async () => {
  const h2 = fakeH2();
  const chunks: string[] = [];
  const { done } = drive(h2, 60, (s: string) => chunks.push(s));
  h2.req.emit("data", frame(buildTextDeltaPayload("partial")));
  await assert.rejects(done, /no model output for 60ms/);
  assert.ok(
    chunks.some((c) => c.includes("partial")),
    "partial output was still emitted"
  );
});

test("non-output frames (kv/keepalive) do not reset the idle watchdog", async () => {
  const h2 = fakeH2();
  const { done } = drive(h2, 80);
  const pump = setInterval(() => h2.req.emit("data", frame(buildKvServerMessagePayload())), 20);
  try {
    await assert.rejects(done, /no model output for 80ms/);
  } finally {
    clearInterval(pump);
  }
});

test("steady model output keeps the stream alive past the idle timeout", async () => {
  const h2 = fakeH2();
  const { ctx, done } = drive(h2, 60);
  for (let i = 0; i < 5; i++) {
    await tick(30);
    h2.req.emit("data", frame(buildTextDeltaPayload(`t${i}`)));
  }
  h2.req.emit("data", frame(buildTurnEndedPayload()));
  await done;
  assert.equal(ctx.totalText, "t0t1t2t3t4");
  assert.equal(h2.req.closed, false, "healthy stream is released, not torn down");
});

test("idleTimeoutMs=0 disables the watchdog", async () => {
  const h2 = fakeH2();
  const { done } = drive(h2, 0);
  let settled = false;
  done.then(
    () => (settled = true),
    () => (settled = true)
  );
  await tick(80);
  assert.equal(settled, false);
  h2.req.emit("end");
  await done;
});
