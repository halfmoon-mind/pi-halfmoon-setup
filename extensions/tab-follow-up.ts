/**
 * While the agent runs, Tab queues the editor text as a follow-up (delivered after the run ends),
 * like pi's Alt+Enter; Enter still steers. An open autocomplete menu, an empty editor, or an idle
 * agent leave Tab as pi's usual autocomplete. The working row names both keys.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export const WORKING_MESSAGE = "Working · Enter to steer · Tab to queue follow-up";

/** Whether Tab should queue a follow-up instead of autocompleting. */
export function tabQueuesFollowUp(running: boolean, autocompleteOpen: boolean, text: string): boolean {
	return running && !autocompleteOpen && text.trim().length > 0;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		class TabFollowUpEditor extends CustomEditor {
			handleInput(data: string): void {
				if (matchesKey(data, "tab") && tabQueuesFollowUp(!ctx.isIdle(), this.isShowingAutocomplete(), this.getText())) {
					this.actionHandlers.get("app.message.followUp")?.();
					return;
				}
				super.handleInput(data);
			}
		}
		// embedWorkingStatus matches pi's default editor, which shows the working row in its border.
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new TabFollowUpEditor(tui, theme, keybindings, { embedWorkingStatus: true }));
		ctx.ui.setWorkingMessage(WORKING_MESSAGE);
	});
}
