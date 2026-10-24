import { test } from "node:test";
import assert from "node:assert/strict";
import { pickContact } from "./resolve.js";
import type { ExpressProfile } from "../types/index.js";

const person = (name: string, email: string, user_huid: string) => ({ name, email, user_huid }) as ExpressProfile;
const borisovs = [
  person("Борисов Игорь Васильевич", "ivborisov@alfabank.ru", "h1"),
  person("Борисов Игорь Валерьевич", "ivborisov2@alfabank.ru", "h2"),
];

test("pickContact: exact full name wins over namesakes (WISHLIST #16)", () => {
  assert.equal(pickContact("борисов игорь валерьевич", borisovs).user_huid, "h2");
});

test("pickContact: exact email wins", () => {
  assert.equal(pickContact("IVBorisov@alfabank.ru", borisovs).user_huid, "h1");
});

test("pickContact: partial name with namesakes is still ambiguous", () => {
  assert.throws(() => pickContact("Борисов Игорь", borisovs), /multiple contacts[\s\S]*h1[\s\S]*h2/);
});

test("pickContact: nothing found", () => {
  assert.throws(() => pickContact("Никто", []), /No chat or contact/);
});
