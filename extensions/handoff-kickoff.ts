// The handoff kickoff message, dependency-free so the sandbox can tell a generated one from the user's own words.

export const KICKOFF_START = "Implement the plan in ";
// Between the kickoff and the copy of the plan /handoff sends with it.
export const PLAN_BODY = "\n\nThe plan as of this handoff (tick steps in the file, not here):\n\n";
// Workers in one parallel call share the working tree and the plan file, so each edits only its step's files and the caller ticks.
export const PARALLEL =
	"Steps tagged with the same (parallel A) letter run as one subagent call: a `tasks` array with one worker per step, each told its step and files, to edit only those files, and not to edit the plan file. When it returns, run each step's check and tick the steps that pass yourself.";
const FIRST_END = ". This session starts empty, so read the plan first; it is your whole context, except that its `## Sources`, when it has them, are the originals to read when a requirement needs more than its quote.";
export const kickoff = (path: string) =>
	[
		`${KICKOFF_START}${path}${FIRST_END}`,
		"Build it yourself, step by step in order. Tick a step ([x]) in the plan file once its check passes.",
		PARALLEL,
		`Call handoff with ${path} between steps, so the rest moves to a fresh session if this one fills up.`,
		"Run every command under the plan's success criteria and show its output. Do not finish while one fails.",
	].join("\n");

/** Whether `text` is exactly a generated kickoff: `kickoff(path)`, alone or followed by the plan-body separator and a body. */
export function isHandoffKickoff(text: string): boolean {
	const first = text.split("\n", 1)[0]!;
	if (!first.startsWith(KICKOFF_START) || !first.endsWith(FIRST_END)) return false;
	const k = kickoff(first.slice(KICKOFF_START.length, -FIRST_END.length));
	return text === k || text.startsWith(k + PLAN_BODY);
}
