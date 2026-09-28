/* ask.h — upstream decision endpoint transport (protocol v2) */
#ifndef DYNOBOX_ASK_H
#define DYNOBOX_ASK_H

#include "dynobox.h"
#include <stddef.h>

/* Ask the endpoint whether `vpath`/`acc` is allowed.
 * On allow, installs any grants the response carries into p.
 * Returns 1 = allow, 0 = deny (timeout / unreachable / bad response —
 * the caller must treat every failure as fail-closed and must not cache).
 * `err` receives a short failure reason for diagnostics. */
int dbox_ask(const dbox_policy_t *p, const char *vpath, int acc,
             char *err, size_t errsz);

/* Reference decision protocol helpers shared with the endpoint:
 * build request JSON and parse a response JSON (decision + grants). */
int dbox_ask_build_request(char *out, size_t outsz, const char *vpath, int acc,
                           const char *token);
/* Parses `body`; on allow installs grants into p (mutable). */
int dbox_ask_parse_response(const char *body, dbox_policy_t *p, int64_t now_ms);

/* Extract a top-level JSON string value by key (escape-aware). Returns 1
 * and fills `out` when present, 0 otherwise. */
int dbox_json_get_string(const char *body, const char *key,
                         char *out, size_t outsz);

#endif
