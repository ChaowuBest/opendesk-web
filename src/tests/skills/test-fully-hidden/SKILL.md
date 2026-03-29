---
name: test-fully-hidden
description: A fully hidden test skill. Neither user nor LLM can invoke it directly.
user-invocable: false
disable-model-invocation: true
---

# Test Fully Hidden Skill

This skill should not appear anywhere - not in the `/` menu, not in the LLM system prompt.
It exists only as an internal reference that can be loaded programmatically.

## Instructions

This skill should never be loaded in normal operation.
