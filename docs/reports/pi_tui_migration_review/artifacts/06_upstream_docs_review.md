# pi-tui upstream docs review

Generated: 2026-07-07T12:42:05.065Z

## Package metadata

| Field                      | Old package                                                                                   | New package                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| name                       | @mariozechner/pi-tui                                                                          | @earendil-works/pi-tui                                                                         |
| version                    | 0.58.4                                                                                        | 0.80.3                                                                                         |
| repository                 | {"type":"git","url":"git+https://github.com/badlogic/pi-mono.git","directory":"packages/tui"} | {"type":"git","url":"git+https://github.com/earendil-works/pi.git","directory":"packages/tui"} |
| engines                    | {"node":">=20.0.0"}                                                                           | {"node":">=22.19.0"}                                                                           |
| types                      | ./dist/index.d.ts                                                                             | ./dist/index.d.ts                                                                              |
| changelog files in package | none                                                                                          | none                                                                                           |

## README keyword coverage

| Keyword          | Old README | New README |
| ---------------- | ---------- | ---------- |
| overlay          | yes        | yes        |
| focus            | yes        | yes        |
| Focusable        | yes        | yes        |
| Keybindings      | no         | no         |
| SelectList       | yes        | yes        |
| Editor           | yes        | yes        |
| Input            | yes        | yes        |
| Markdown         | yes        | yes        |
| visibleWidth     | yes        | yes        |
| truncateToWidth  | yes        | yes        |
| wrapTextWithAnsi | yes        | yes        |
| migration        | no         | no         |
| breaking         | no         | no         |

## Read-only conclusion

- The published packages contain README files but no packaged CHANGELOG/migration document.
- The new README explicitly documents overlay focus release with `handle.unfocus({ target })` and `Focusable` cursor propagation, so focus/overlay behavior cannot be closed by type diff alone.
- Because no packaged migration guide was found, OpenDesk treats upstream docs as explanatory evidence and keeps behavior/PTY evidence as the release gate.
