// Run: node --import ./extensions/test-hooks.ts --test extensions/tab-follow-up.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { tabQueuesFollowUp } from "./tab-follow-up.ts";

test("Tab queues a follow-up only while running, with text, and no autocomplete menu", () => {
	assert.equal(tabQueuesFollowUp(true, false, "next question"), true);
	assert.equal(tabQueuesFollowUp(false, false, "next question"), false);
	assert.equal(tabQueuesFollowUp(true, true, "next question"), false);
	assert.equal(tabQueuesFollowUp(true, false, "  \n"), false);
});
