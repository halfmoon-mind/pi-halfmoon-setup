---
description: Worker implements, reviewer reviews, worker applies feedback
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "worker" agent to implement: $@
2. Then, use the "reviewer" agent to review the implementation from the previous step (use {previous} placeholder)
3. Finally, use the "worker" agent to fix the Critical issues from the review, skipping Warnings and Suggestions (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
