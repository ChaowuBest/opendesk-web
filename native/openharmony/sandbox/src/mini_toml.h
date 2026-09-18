/* mini_toml.h — minimal TOML subset parser for dynobox rule files.
 * Supports: comments, [table], [[array-of-tables]], bare keys,
 * basic strings (with escapes), integers, booleans. */
#ifndef DYNOBOX_MINI_TOML_H
#define DYNOBOX_MINI_TOML_H

#include <stddef.h>

typedef enum { TV_STR = 0, TV_INT, TV_BOOL } tval_type_t;

typedef struct {
    char *section;    /* "" (root), "ask", "network", "roots", "rules", ... */
    int   aot_index;  /* -1 = plain table; >=0 = n-th [[section]] occurrence */
    char *key;
    tval_type_t type;
    char *s;          /* TV_STR */
    long  i;          /* TV_INT */
    int   b;          /* TV_BOOL */
} tentry_t;

typedef struct {
    tentry_t *e;
    int n, cap;
} tdoc_t;

/* Returns 0 on success; on error returns -1 and fills `err`. */
int  mini_toml_parse(const char *text, tdoc_t *doc, char *err, size_t errsz);
void mini_toml_free(tdoc_t *doc);

/* Lookup helpers over the parsed document. */
const tentry_t *mini_toml_find(const tdoc_t *d, const char *section,
                               int aot_index, const char *key);

#endif
