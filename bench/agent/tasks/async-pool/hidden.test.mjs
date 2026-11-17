import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLimit } from "./src/pool.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("hidden: at most limit in flight, results in input order", async () => {
	const items = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
	const delays = [5, 4, 3, 2, 1, 0, 5, 4, 3, 2];
	let inFlight = 0;
	let peak = 0;
	const out = await mapLimit(items, 3, async (x, i) => {
		peak = Math.max(peak, ++inFlight);
		await sleep(delays[i]);
		inFlight--;
		return `${x}${i}`;
	});
	assert.equal(peak, 3);
	assert.deepEqual(out, items.map((x, i) => `${x}${i}`));
});

test("hidden: a limit above the item count", async () => {
	assert.deepEqual(await mapLimit([1, 2], 20, async (x) => x + 1), [2, 3]);
});

test("hidden: empty input never calls fn", async () => {
	let calls = 0;
	assert.deepEqual(await mapLimit([], 2, async () => calls++), []);
	assert.equal(calls, 0);
});

test("hidden: a bad limit rejects with RangeError", async () => {
	const fn = async (x) => x;
	await assert.rejects(mapLimit([1], 0, fn), RangeError);
	await assert.rejects(mapLimit([1], 1.5, fn), RangeError);
});

test("hidden: the first rejection stops new calls", async () => {
	const started = [];
	const boom = new Error("item 1 failed");
	const fn = async (x, i) => {
		started.push(i);
		if (i === 1) {
			await sleep(1);
			throw boom;
		}
		await sleep(i === 0 ? 5 : 0);
		return x;
	};
	await assert.rejects(mapLimit([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 2, fn), (e) => e === boom);
	await sleep(20);
	assert.deepEqual(started, [0, 1]);
});
