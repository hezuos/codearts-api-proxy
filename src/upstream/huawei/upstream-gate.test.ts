/**
 * 上游并发槽位控制测试（upstream-gate.ts）。
 *
 * 覆盖：
 * - 同一账号并发数不超过上限
 * - FIFO 排队顺序
 * - 排队中 AbortSignal 取消
 * - 排队等待超时
 * - limit=0 关闭闸门
 * - release 幂等
 * - TM.00001041 错误识别
 */
import assert from "assert";
import {
  acquireUpstreamSlot,
  isConcurrentSessionLimitError,
  reportConcurrencyLimit,
  reportUpstreamSuccess,
  __testHooks,
} from "./upstream-gate";

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testEnforcesLimit(): Promise<void> {
  __testHooks.reset();
  __testHooks.setLimit(1);

  const release1 = await acquireUpstreamSlot("acc-limit");
  let secondAcquired = false;
  const secondPromise = acquireUpstreamSlot("acc-limit").then((release) => {
    secondAcquired = true;
    return release;
  });

  await tick();
  assert.equal(secondAcquired, false, "second acquire must wait for the only slot");
  assert.deepEqual(__testHooks.stats("acc-limit"), { active: 1, queued: 1, limit: 1 });

  release1();
  const release2 = await secondPromise;
  assert.equal(secondAcquired, true, "second acquire should resolve after release");
  assert.deepEqual(__testHooks.stats("acc-limit"), { active: 1, queued: 0, limit: 1 });

  release2();
  assert.deepEqual(__testHooks.stats("acc-limit"), { active: 0, queued: 0, limit: 1 });
}

async function testFifoOrder(): Promise<void> {
  __testHooks.reset();
  __testHooks.setLimit(1);

  const order: number[] = [];
  const release1 = await acquireUpstreamSlot("acc-fifo");

  const secondPromise = acquireUpstreamSlot("acc-fifo").then((release) => {
    order.push(2);
    return release;
  });
  await tick();

  const thirdPromise = acquireUpstreamSlot("acc-fifo").then((release) => {
    order.push(3);
    return release;
  });
  await tick();

  release1();
  const release2 = await secondPromise;
  assert.deepEqual(order, [2], "waiter #2 should be served first");

  release2();
  const release3 = await thirdPromise;
  assert.deepEqual(order, [2, 3], "waiter #3 should be served next");
  release3();

  __testHooks.reset();
}

async function testAbortWhileQueued(): Promise<void> {
  __testHooks.reset();
  __testHooks.setLimit(1);

  const release1 = await acquireUpstreamSlot("acc-abort");
  const controller = new AbortController();
  const queued = acquireUpstreamSlot("acc-abort", controller.signal);
  await tick();

  controller.abort();
  await assert.rejects(queued, /aborted/i);
  assert.deepEqual(__testHooks.stats("acc-abort"), { active: 1, queued: 0, limit: 1 });

  release1();
  assert.deepEqual(__testHooks.stats("acc-abort"), { active: 0, queued: 0, limit: 1 });
}

async function testQueueTimeout(): Promise<void> {
  __testHooks.reset();
  __testHooks.setLimit(1);
  __testHooks.setWaitTimeout(30);

  const release1 = await acquireUpstreamSlot("acc-timeout");
  // 等待计时器未 ref，必须让 ref 的 tick 保持在途，否则进程会提前退出。
  await Promise.all([
    assert.rejects(acquireUpstreamSlot("acc-timeout"), /Timed out/i),
    tick(60),
  ]);
  assert.deepEqual(__testHooks.stats("acc-timeout"), { active: 1, queued: 0, limit: 1 });

  release1();
  __testHooks.reset();
}

async function testDisabledGate(): Promise<void> {
  __testHooks.reset();
  __testHooks.setLimit(0);

  const release1 = await acquireUpstreamSlot("acc-disabled");
  const release2 = await acquireUpstreamSlot("acc-disabled");
  assert.deepEqual(
    __testHooks.stats("acc-disabled"),
    { active: 0, queued: 0, limit: 1 },
    "disabled gate should not track slots",
  );

  release1();
  release2();
  __testHooks.reset();
}

async function testReleaseIsIdempotent(): Promise<void> {
  __testHooks.reset();
  __testHooks.setLimit(1);

  const release1 = await acquireUpstreamSlot("acc-idempotent");
  release1();
  release1(); // 重复释放不得把 active 减到负数或偷走后续槽位

  const release2 = await acquireUpstreamSlot("acc-idempotent");
  let queuedAcquired = false;
  const queued = acquireUpstreamSlot("acc-idempotent").then((release) => {
    queuedAcquired = true;
    return release;
  });
  await tick();
  assert.equal(queuedAcquired, false, "slot must still be held by release2");

  release2();
  const release3 = await queued;
  release3();
  assert.deepEqual(__testHooks.stats("acc-idempotent"), { active: 0, queued: 0, limit: 1 });
  __testHooks.reset();
}

function testConcurrentSessionErrorDetection(): void {
  assert.equal(
    isConcurrentSessionLimitError(
      '{"status":400,"body":"{\\"error_code\\":\\"TM.00001041\\",\\"error_msg\\":\\"并发会话数已达上限(3个)\\"}"}',
    ),
    true,
    "should detect TM.00001041 payload",
  );
  assert.equal(isConcurrentSessionLimitError("TM.00001041"), true);
  assert.equal(isConcurrentSessionLimitError("并发会话数已达上限(3个)，请关闭部分会话后重试。"), true);
  assert.equal(isConcurrentSessionLimitError("ChatAgent.00001216"), false);
  assert.equal(isConcurrentSessionLimitError(undefined), false);
  assert.equal(isConcurrentSessionLimitError(""), false);
}

async function testAdaptiveDowngrade(): Promise<void> {
  __testHooks.reset();
  __testHooks.setLimit(3);

  const release1 = await acquireUpstreamSlot("acc-adapt");
  const release2 = await acquireUpstreamSlot("acc-adapt");
  assert.equal(__testHooks.stats("acc-adapt").limit, 3);

  // 撞限一次 → 有效上限下调到 2
  reportConcurrencyLimit("acc-adapt");
  assert.equal(__testHooks.stats("acc-adapt").limit, 2);

  // 连续撞限一路降到下限 1，不得低于 1
  reportConcurrencyLimit("acc-adapt");
  reportConcurrencyLimit("acc-adapt");
  assert.equal(__testHooks.stats("acc-adapt").limit, 1);

  // 降限后排队：active 2 > limit 1，释放一个后才放行
  let queuedAcquired = false;
  const queued = acquireUpstreamSlot("acc-adapt").then((release) => {
    queuedAcquired = true;
    return release;
  });
  await tick();
  assert.equal(queuedAcquired, false, "downgraded limit must block new requests");

  release1();
  await tick();
  assert.equal(queuedAcquired, false, "active(1) is not below limit(1)");

  release2();
  const release3 = await queued;
  assert.equal(queuedAcquired, true, "slot is admitted once active drops below limit");
  release3();
  __testHooks.reset();
}

async function testAdaptiveRecovery(): Promise<void> {
  __testHooks.reset();
  __testHooks.setLimit(3);
  __testHooks.setRecoverMs(20);

  const release1 = await acquireUpstreamSlot("acc-recover");
  reportConcurrencyLimit("acc-recover");
  assert.equal(__testHooks.stats("acc-recover").limit, 2);

  // 恢复窗口内不复原
  await tick(5);
  reportUpstreamSuccess("acc-recover");
  assert.equal(__testHooks.stats("acc-recover").limit, 2);

  // 超过窗口后每次 +1，直到恢复配置上限
  await tick(40);
  reportUpstreamSuccess("acc-recover");
  assert.equal(__testHooks.stats("acc-recover").limit, 3);

  release1();
  __testHooks.reset();
}

async function run(): Promise<void> {
  testConcurrentSessionErrorDetection();
  await testEnforcesLimit();
  await testFifoOrder();
  await testAbortWhileQueued();
  await testQueueTimeout();
  await testDisabledGate();
  await testReleaseIsIdempotent();
  await testAdaptiveDowngrade();
  await testAdaptiveRecovery();
  console.log("All upstream gate tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
