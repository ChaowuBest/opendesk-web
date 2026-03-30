---
name: test-manual-only
description: A manual-only test skill. Only user can invoke via /test-manual-only, LLM cannot auto-activate.
user-invocable: true
disable-model-invocation: true
argument-hint: "[optional-arg]"
---

# Test Manual-Only Skill

This skill can only be triggered by the user typing `/test-manual-only`.
The LLM should NOT be able to see this skill's description in the system prompt.

## Instructions

When loaded, confirm: "test-manual-only skill loaded via explicit user command".
