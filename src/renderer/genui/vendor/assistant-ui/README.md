# assistant-ui Elements (vendored)

Source: https://github.com/assistant-ui/assistant-ui, commit `7d7427653f6ba47b0b954510eed9c594d64e74d5`,
directory `packages/ui/src/components/react/assistant-ui/{elements,utils}` (MIT, see `LICENSE`).

Local changes:

- removed the `"use client"` directives and pointed `@/lib/utils` at `lib/utils.ts` (clsx + tailwind-merge);
- `question-flow.tsx`: `nextLabel` prop for the non-final confirm button;
- `elicitation-form.tsx`: `labels` prop for the built-in texts;
- `comparison-card.tsx`: `recommendedLabel` prop for the recommended badge.

Keep the rest identical to upstream so later updates can be diffed against the commit above.
