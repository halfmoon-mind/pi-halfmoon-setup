// Run: node --import ./extensions/test-hooks.ts --test extensions/startup.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { missing } from "./startup.ts";

test("each missing tool or login, and an unset hideThinkingBlock, is named with its fix, and a set-up machine gets none", async () => {
	const bin = mkdtempSync(join(tmpdir(), "startup-bin-"));
	// A dir with no keychain item nor credentials file: Claude Code is logged out.
	process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "startup-claude-"));
	process.env.PATH = bin;
	const registry = (configured: boolean) => ({ modelRegistry: { getProviderAuthStatus: () => ({ configured }) } }) as any;

	const set = { hideThinkingBlock: false };
	assert.deepEqual((await missing(registry(false), {})).map((m) => m.split(/[,;]/)[0]), ["claude CLI not found", "openai has no credentials", "poppler not found", "pandoc not found", "LibreOffice not found", "thinking blocks show in full"]);
	for (const name of ["claude", "pdftotext", "pandoc", "soffice"]) writeFileSync(join(bin, name), "");
	assert.match((await missing(registry(true), set))[0], /not logged in.*claude auth login/);
	writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
	assert.deepEqual(await missing(registry(true), set), []);
	assert.deepEqual(await missing(registry(true), { hideThinkingBlock: true }), []);
});
