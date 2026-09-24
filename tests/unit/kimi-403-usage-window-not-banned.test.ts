import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProviderError,
  PROVIDER_ERROR_TYPES,
} from "../../open-sse/services/errorClassifier.ts";
import { checkFallbackError } from "../../open-sse/services/accountFallback.ts";
import { isSubscriptionQuotaText } from "../../open-sse/services/quotaTextCooldowns.ts";

// Kimi Coding answers an exhausted rolling 5-hour window with HTTP 403. The unmatched-403
// branch classified it FORBIDDEN, which markAccountUnavailable turns into the TERMINAL
// "banned" status — the connection never came back after the window renewed and needed
// a manual DB reset (production, 2026-09-23).
const KIMI_5H_BODY = {
  error: {
    message:
      "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription",
    type: "forbidden",
  },
};

test("windowed usage-limit phrasing is recognized as subscription quota", () => {
  for (const text of [
    "you've reached your 5-hour usage limit.",
    "you have reached your weekly usage limit",
    "you've reached your daily usage limit",
    "you've reached your usage limit",
  ]) {
    assert.equal(isSubscriptionQuotaText(text), true, text);
  }
});

test("unrelated 403 wording is not treated as a usage window", () => {
  assert.equal(isSubscriptionQuotaText("you have reached the end of the document"), false);
  assert.equal(isSubscriptionQuotaText("access denied: usage policy violation"), false);
});

test("Kimi 403 5-hour usage limit classifies as QUOTA_EXHAUSTED, not FORBIDDEN", () => {
  assert.equal(
    classifyProviderError(403, KIMI_5H_BODY, "kimi-coding"),
    PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED
  );
});

test("Kimi 403 5-hour usage limit falls back with a renewable cooldown, not a permanent state", () => {
  const result = checkFallbackError(403, JSON.stringify(KIMI_5H_BODY), 0, "k3", "kimi-coding");
  assert.equal(result.shouldFallback, true);
  assert.notEqual(result.permanent, true);
  assert.notEqual(result.creditsExhausted, true);
  assert.ok(result.cooldownMs > 0, "must cool down so the window can renew");
});
