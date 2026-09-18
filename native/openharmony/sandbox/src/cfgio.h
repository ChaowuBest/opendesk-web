/* cfgio.h — serialize the policy + runtime settings into an environment
 * variable (base64). The launcher computes it once; the preload library
 * decodes it at startup so sandboxed processes never re-read (and can
 * never rewrite) the policy file. */
#ifndef DYNOBOX_CFGIO_H
#define DYNOBOX_CFGIO_H

#include "dynobox.h"
#include <stddef.h>

/* Returns malloc'd base64 string (caller frees) or NULL on error. */
char *dbox_cfg_encode(const dbox_policy_t *p);

/* Decode into p (policy_init'ed first). Returns 0 / -1. */
int dbox_cfg_decode(const char *b64, dbox_policy_t *p);

#endif
