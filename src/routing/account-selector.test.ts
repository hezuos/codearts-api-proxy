/**
 * 账号选择器测试（add-account-routing 组 3）。
 *
 * 覆盖：空槽探测只读、粘性映射与选择顺序、冷却跳过与恢复、选择日志字段。
 */
import assert from "assert";
import { config } from "../config";
import {
  acquireUpstreamSlot,
  __testHooks as gateHooks,
} from "../upstream/huawei/upstream-gate";
import {
  hasFreeSlot,
  selectAccount,
  setStickyAccount,
  getStickyAccount,
  markAccountCoolingDown,
  clearAccountCooldown,
  isAccountCoolingDown,
  getCooldownRemainingMs,
  listAccountCooldowns,
  countStickyBindings,
  getRoundRobinCursor,
  __testHooks as selectorHooks,
  type CandidateAccount,
} from "./account-selector";

function candidate(
  accountId: string,
  hasSlot = true,
): CandidateAccount {
  return { accountId, keyId: `key-${accountId}`, hasFreeSlot: hasSlot };
}

/** 捕获 stdout 中的日志行。 */
function captureLogs(fn: () => void): string {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: unknown }).write = (
    chunk: unknown,
  ): boolean => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    (process.stdout as unknown as { write: unknown }).write = original;
  }
  return lines.join("");
}

function reset(): void {
  selectorHooks.reset();
  gateHooks.reset();
}

// ---------------------------------------------------------------------------
// 3.1 槽位可用性：只读，不占槽
// ---------------------------------------------------------------------------

async function testHasFreeSlotIsReadOnly(): Promise<void> {
  reset();
  gateHooks.setLimit(1);

  const before = gateHooks.stats("acc-slot");
  assert.equal(hasFreeSlot("acc-slot"), true, "未占用时应有空闲槽位");
  assert.deepEqual(
    gateHooks.stats("acc-slot"),
    before,
    "探测 SHALL NOT 改变闸门状态",
  );

  const release = await acquireUpstreamSlot("acc-slot");
  assert.equal(hasFreeSlot("acc-slot"), false, "槽位占满时应无空闲槽位");

  const occupied = gateHooks.stats("acc-slot");
  hasFreeSlot("acc-slot");
  assert.deepEqual(
    gateHooks.stats("acc-slot"),
    occupied,
    "占用状态下探测仍 SHALL NOT 改变闸门状态",
  );

  release();
  assert.equal(hasFreeSlot("acc-slot"), true, "释放后应重新有空闲槽位");
}

// ---------------------------------------------------------------------------
// 3.2 粘性映射与选择顺序
// ---------------------------------------------------------------------------

function testConversationPolicyBindsAndReuses(): void {
  reset();

  const first = selectAccount({
    keyId: "k1",
    policy: "conversation",
    conversationId: "conv-1",
    candidates: [candidate("acc-A"), candidate("acc-B"), candidate("acc-C")],
  });
  assert.ok(first);
  assert.equal(first?.reason, "round-robin", "新对话无绑定，应按轮询分配");
  assert.equal(first?.bindConversation, true, "新分配应记录绑定");

  setStickyAccount("k1", "conv-1", first!.accountId);
  assert.equal(
    getStickyAccount("k1", "conv-1"),
    first!.accountId,
    "绑定应可按 (Key, 对话标识) 查回",
  );

  const second = selectAccount({
    keyId: "k1",
    policy: "conversation",
    conversationId: "conv-1",
    candidates: [candidate("acc-A"), candidate("acc-B"), candidate("acc-C")],
  });
  assert.equal(second?.accountId, first?.accountId, "同对话后续轮次应命中原账号");
  assert.equal(second?.reason, "sticky-hit", "应记为绑定命中");
  assert.equal(second?.bindConversation, false, "命中绑定不应重新记录");
}

function testStickyAccountSaturatedFallsToAnother(): void {
  reset();
  setStickyAccount("k1", "conv-2", "acc-A");

  const result = selectAccount({
    keyId: "k1",
    policy: "conversation",
    conversationId: "conv-2",
    candidates: [candidate("acc-A", false), candidate("acc-B")],
  });

  assert.equal(result?.accountId, "acc-B", "粘性账号饱和时应改用其它账号");
  assert.equal(result?.reason, "round-robin");
  assert.equal(result?.bindConversation, true, "改选后应改绑");
}

function testRequestPolicyDoesNotStick(): void {
  reset();

  const first = selectAccount({
    keyId: "k2",
    policy: "request",
    conversationId: "conv-3",
    candidates: [candidate("acc-A"), candidate("acc-B"), candidate("acc-C")],
  });
  assert.ok(first);
  assert.equal(first?.bindConversation, false, "请求粒度不记录绑定");

  const second = selectAccount({
    keyId: "k2",
    policy: "request",
    conversationId: "conv-3",
    candidates: [candidate("acc-A"), candidate("acc-B"), candidate("acc-C")],
  });
  assert.notEqual(second?.accountId, first?.accountId, "请求粒度每请求重新分配");
  assert.equal(second?.reason, "round-robin");
}

function testCapacityPreferredOverRoundRobinPosition(): void {
  reset();

  const result = selectAccount({
    keyId: "k3",
    policy: "request",
    candidates: [candidate("acc-A", false), candidate("acc-B")],
  });
  assert.equal(result?.accountId, "acc-B", "有空闲槽位的账号应优先");
}

function testEmptyCandidateSetReturnsNull(): void {
  reset();
  const result = selectAccount({
    keyId: "k4",
    policy: "conversation",
    conversationId: "conv-4",
    candidates: [],
  });
  assert.equal(result, null);
}

// ---------------------------------------------------------------------------
// 3.3 冷却
// ---------------------------------------------------------------------------

function testCoolingAccountIsSkipped(): void {
  reset();
  markAccountCoolingDown("acc-A", "concurrency");

  assert.equal(isAccountCoolingDown("acc-A"), true);
  assert.ok(getCooldownRemainingMs("acc-A") > 0, "冷却期应剩余正时间");

  const result = selectAccount({
    keyId: "k5",
    policy: "request",
    candidates: [candidate("acc-A"), candidate("acc-B")],
  });
  assert.equal(result?.accountId, "acc-B", "冷却中的账号应被跳过");
}

function testCooldownExpires(): void {
  reset();
  const original = config.routingCooldownConcurrencyMs;
  config.routingCooldownConcurrencyMs = 50;
  try {
    markAccountCoolingDown("acc-A", "concurrency");
    assert.equal(isAccountCoolingDown("acc-A"), true, "冷却期内应处于冷却状态");
    // 等待冷却窗口过去
    const until = Date.now() + 70;
    while (Date.now() < until) {
      // busy wait
    }
    assert.equal(isAccountCoolingDown("acc-A"), false, "冷却到期后应恢复");
  } finally {
    config.routingCooldownConcurrencyMs = original;
  }
}

function testAllAccountsCoolingFallsBackToAll(): void {
  reset();
  markAccountCoolingDown("acc-A", "concurrency");
  markAccountCoolingDown("acc-B", "concurrency");

  const result = selectAccount({
    keyId: "k6",
    policy: "request",
    candidates: [candidate("acc-A"), candidate("acc-B")],
  });
  assert.ok(result, "全部冷却时仍应返回一个候选，由闸门排队兜底");
}

function testClearCooldown(): void {
  reset();
  markAccountCoolingDown("acc-A", "credential");
  clearAccountCooldown("acc-A");
  assert.equal(isAccountCoolingDown("acc-A"), false);
  assert.deepEqual(listAccountCooldowns(), []);
}

// ---------------------------------------------------------------------------
// 3.4 选择日志
// ---------------------------------------------------------------------------

function testSelectionIsLogged(): void {
  reset();
  const output = captureLogs(() => {
    selectAccount({
      keyId: "k7",
      policy: "conversation",
      conversationId: "conv-7",
      candidates: [candidate("acc-A")],
    });
  });

  assert.ok(output.includes("account selected"), "应输出选择日志");
  assert.ok(output.includes("conv-7"), "日志应含对话标识");
  assert.ok(output.includes("acc-A"), "日志应含选中账号");
  assert.ok(output.includes("round-robin"), "日志应含选择依据");
  assert.ok(output.includes("conversation"), "日志应含分配粒度");
}

function testRestartShowsNoBindingReason(): void {
  reset();
  // 模拟重启：绑定表清空
  selectorHooks.reset();

  const output = captureLogs(() => {
    selectAccount({
      keyId: "k8",
      policy: "conversation",
      conversationId: "conv-8",
      candidates: [candidate("acc-A")],
    });
  });
  assert.ok(
    output.includes("round-robin") && !output.includes("sticky-hit"),
    "重启后首次选择依据应为无绑定",
  );
  assert.equal(countStickyBindings(), 0);
  assert.equal(getRoundRobinCursor("k8"), 1);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await testHasFreeSlotIsReadOnly();
  testConversationPolicyBindsAndReuses();
  testStickyAccountSaturatedFallsToAnother();
  testRequestPolicyDoesNotStick();
  testCapacityPreferredOverRoundRobinPosition();
  testEmptyCandidateSetReturnsNull();
  testCoolingAccountIsSkipped();
  testCooldownExpires();
  testAllAccountsCoolingFallsBackToAll();
  testClearCooldown();
  testSelectionIsLogged();
  testRestartShowsNoBindingReason();
  console.log("All account selector tests passed.");
}

void main();
