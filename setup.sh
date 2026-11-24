#!/usr/bin/env bash
# Checks what the pi-halfmoon-setup package needs and installs or signs in to only what is missing, so a rerun changes nothing.
# Run: ./setup.sh, or curl -fsSL https://raw.githubusercontent.com/halfmoon-mind/pi-halfmoon-setup/main/setup.sh | bash
# macOS /bin/bash is 3.2: no associative arrays, no empty arrays under set -u.
set -euo pipefail

# Logins need the keyboard, and under curl | bash stdin is the script itself; the test points this at /dev/null.
tty=${SETUP_TTY:-/dev/tty}
pkg=git:github.com/halfmoon-mind/pi-halfmoon-setup

# need <binary> <brew install args…>, the formula or cask name last.
need() {
	local bin=$1
	shift
	if command -v "$bin" >/dev/null; then echo "✓ $bin"; return; fi
	command -v brew >/dev/null || { echo "✗ Homebrew not found: install it from https://brew.sh, then rerun"; exit 1; }
	echo "→ installing $*"
	brew install "$@"
}

# In a function so bash reads the whole script first: under curl | bash a child reading stdin would eat the rest.
main() {
	local missing=0 packages

	# Before the pi/claude checks, so Linux gets every step even when they are missing.
	if [[ $OSTYPE != darwin* ]]; then
		printf '%s\n' "setup.sh installs on macOS only. On Linux, run:" \
			"  apt-get install poppler-utils pandoc ripgrep bubblewrap socat libreoffice" \
			"  if missing, install pi from https://pi.dev and Claude Code with: curl -fsSL https://claude.ai/install.sh | bash" \
			"  pi install $pkg" "  claude auth login" "  pi auth login openai   (or export OPENAI_API_KEY)" \
			"and add to ~/.pi/agent/settings.json: \"quietStartup\": \"header\", \"hideThinkingBlock\": true, \"steeringMode\": \"all\", \"followUpMode\": \"all\""
		exit 1
	fi

	command -v pi >/dev/null || { echo "✗ pi not found: install it from https://pi.dev, then rerun"; missing=1; }
	command -v claude >/dev/null || { echo "✗ claude not found: install Claude Code (curl -fsSL https://claude.ai/install.sh | bash), then rerun"; missing=1; }
	[ "$missing" = 0 ] || exit 1

	need pdftotext poppler
	need pandoc pandoc
	need rg ripgrep
	need soffice --cask libreoffice

	# A local checkout's path contains the name too, so it counts as installed. A separate assignment so a failed list stops setup.
	packages=$(pi list)
	if [[ $packages == *pi-halfmoon-setup* ]]; then echo "✓ pi package"; else echo "→ pi install $pkg"; pi install "$pkg"; fi
	if claude auth status >/dev/null 2>&1; then echo "✓ claude login"; else echo "→ claude auth login"; claude auth login <"$tty"; fi
	# not_ready (1) and invalid (2) both sign in again; ChatGPT subscription in the browser. An exported OPENAI_API_KEY counts as ready.
	if pi auth check --provider openai >/dev/null 2>&1; then echo "✓ openai login"; else echo "→ pi auth login openai"; pi auth login openai <"$tty"; fi

	# Adds only absent keys, keeps the user's values and 2-space JSON; invalid JSON throws and nothing is written.
	node -e '
		const fs = require("fs"), path = require("path");
		const file = path.join(process.env.HOME, ".pi/agent/settings.json");
		const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
		const want = { quietStartup: "header", hideThinkingBlock: true, steeringMode: "all", followUpMode: "all" };
		const added = Object.keys(want).filter((k) => !(k in settings));
		if (added.length) {
			for (const k of added) settings[k] = want[k];
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
			console.log(`→ settings.json: added ${added.join(", ")}`);
		} else console.log("✓ settings.json");
	'
}

main "$@"
