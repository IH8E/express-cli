import { test } from "node:test";
import assert from "node:assert/strict";
import { activeTypers, applyTyping, typingLabel, type TypingState } from "./typing.js";

const T0 = 1_000_000;

test("applyTyping records a typist with an expiry", () => {
  const state = applyTyping({}, { chatId: "c1", userHuid: "u1", stopped: false }, T0, 5000);
  assert.deepEqual(state, { c1: { u1: T0 + 5000 } });
});

test("applyTyping removes a typist on stop_typing", () => {
  const started = applyTyping({}, { chatId: "c1", userHuid: "u1", stopped: false }, T0, 5000);
  const stopped = applyTyping(started, { chatId: "c1", userHuid: "u1", stopped: true }, T0 + 100, 5000);
  assert.deepEqual(stopped, { c1: {} });
});

test("applyTyping keeps chats apart", () => {
  let state: TypingState = applyTyping({}, { chatId: "c1", userHuid: "u1", stopped: false }, T0);
  state = applyTyping(state, { chatId: "c2", userHuid: "u2", stopped: false }, T0);
  assert.deepEqual(activeTypers(state, "c1", T0), ["u1"]);
  assert.deepEqual(activeTypers(state, "c2", T0), ["u2"]);
});

test("activeTypers drops a hint once it expires, without a stop event", () => {
  const state = applyTyping({}, { chatId: "c1", userHuid: "u1", stopped: false }, T0, 5000);
  assert.deepEqual(activeTypers(state, "c1", T0 + 4999), ["u1"], "still fresh just before the TTL");
  assert.deepEqual(activeTypers(state, "c1", T0 + 5001), [], "expired — an abandoned draft stops showing");
});

test("applyTyping ignores an empty huid instead of creating a phantom typist", () => {
  const state = applyTyping({}, { chatId: "c1", userHuid: "", stopped: false }, T0);
  assert.deepEqual(state, {});
});

test("typingLabel is empty when nobody types", () => {
  assert.equal(typingLabel([], (h) => h), "");
});

test("typingLabel shows up to two names and counts the rest", () => {
  const nameOf = (h: string) => ({ u1: "Иванов", u2: "Петров", u3: "Сидоров" }[h] ?? h);
  assert.equal(typingLabel(["u1"], nameOf), "Иванов печатает…");
  assert.equal(typingLabel(["u1", "u2"], nameOf), "Иванов, Петров печатает…");
  assert.equal(typingLabel(["u1", "u2", "u3"], nameOf), "Иванов, Петров +1 печатает…");
});

test("a repeated push extends the expiry", () => {
  const first = applyTyping({}, { chatId: "c1", userHuid: "u1", stopped: false }, T0, 5000);
  const second = applyTyping(first, { chatId: "c1", userHuid: "u1", stopped: false }, T0 + 4000, 5000);
  assert.deepEqual(activeTypers(second, "c1", T0 + 8000), ["u1"], "still typing after the original TTL");
});
