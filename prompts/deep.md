---
description: Deep worker (GPT-6.1 Sol) delivers one logic-heavy goal; the worker takes over when it escalates
---
Use the subagent tool to run the "deep-worker" agent with this task: $@

If its output starts with `ESCALATE:`, run the "worker" agent on the same task, adding the deep-worker's findings and the decision it could not settle.
