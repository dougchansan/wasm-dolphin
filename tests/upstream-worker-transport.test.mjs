import assert from "node:assert/strict";
import test from "node:test";

import { UpstreamWorkerAdapter } from "../src/upstream-worker-adapter.js";

test("adapter marks only known fire-and-forget calls as one-way", () => {
  const posted = [];
  const adapter = new UpstreamWorkerAdapter();
  adapter.worker = {
    postMessage(message, transfer) {
      posted.push({ message, transfer });
    }
  };

  adapter.post("setInputMask", { mask: 3 });
  adapter.post("unknownFutureRequest", { value: 1 });

  assert.deepEqual(posted[0], {
    message: { type: "setInputMask", payload: { mask: 3 }, oneWay: true },
    transfer: []
  });
  assert.deepEqual(posted[1], {
    message: { type: "unknownFutureRequest", payload: { value: 1 } },
    transfer: []
  });
  assert.equal(adapter.transportTelemetry().oneWayRequestsPosted, 1);
});

test("adapter request/reply promises retain numeric IDs and resolution semantics", async () => {
  let posted;
  const adapter = new UpstreamWorkerAdapter();
  adapter.worker = {
    postMessage(message, transfer) {
      posted = { message, transfer };
    }
  };

  const responsePromise = adapter.request("runFrame", { sample: true });
  assert.deepEqual(posted, {
    message: { id: 1, type: "runFrame", payload: { sample: true } },
    transfer: []
  });
  adapter.handleMessage({ id: 1, ok: true, frame: 7 });
  assert.deepEqual(await responsePromise, { id: 1, ok: true, frame: 7 });
  assert.equal(adapter.pending.size, 0);
});

test("adapter accounts for legacy acknowledgements and preserved one-way errors", () => {
  const adapter = new UpstreamWorkerAdapter({ legacyOneWayAck: true });

  adapter.handleMessage({ id: undefined, ok: true });
  adapter.handleMessage({ id: undefined, ok: false, error: "input failed" });

  assert.deepEqual(adapter.transportTelemetry(), {
    schema: "wasm-dolphin.worker-transport.v1",
    legacyOneWayAck: true,
    oneWayRequestsPosted: 0,
    requestMessagesPosted: 0,
    unmatchedSuccessRepliesReceived: 1,
    unmatchedErrorRepliesReceived: 1
  });
});
