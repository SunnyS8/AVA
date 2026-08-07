import { describe, it, expect } from "vitest";
import { DialogQueue } from "../../src/channels/bitrix/queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("DialogQueue", () => {
  it("keeps order inside one dialog", async () => {
    const q = new DialogQueue();
    const order: string[] = [];
    q.enqueue("a", async () => { await sleep(20); order.push("first"); });
    q.enqueue("a", async () => { order.push("second"); });
    await q.idle();
    expect(order).toEqual(["first", "second"]);
  });

  it("runs different dialogs in parallel", async () => {
    const q = new DialogQueue();
    const order: string[] = [];
    q.enqueue("a", async () => { await sleep(30); order.push("slow"); });
    q.enqueue("b", async () => { order.push("fast"); });
    await q.idle();
    expect(order).toEqual(["fast", "slow"]);
  });

  it("a failing job does not block the next one", async () => {
    const q = new DialogQueue();
    const order: string[] = [];
    q.enqueue("a", async () => { throw new Error("boom"); });
    q.enqueue("a", async () => { order.push("after"); });
    await q.idle();
    expect(order).toEqual(["after"]);
  });
});
