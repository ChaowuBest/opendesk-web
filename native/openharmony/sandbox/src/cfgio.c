/* cfgio.c — policy serialization for the DYNOBOX_CFG environment variable.
 *
 * Format (line-based; every field base64-encoded so any byte sequence is
 * representable):
 *   V 1
 *   P <default_perm> <net_mode> <system_read> <timeout_ms> <cache_ttl> <grant_ttl>
 *   E <b64 endpoint>
 *   R <b64 root.vpath> <b64 root.rpath>
 *   U <b64 map.from> <b64 map.to>
 *   L <b64 glob> <acc> <perm>
 * The whole blob is then base64-encoded into the env var itself.
 */
#define _GNU_SOURCE
#include "cfgio.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* growable buffer */
typedef struct { char *d; size_t n, cap; } sbuf_t;

static void sb_add(sbuf_t *b, const char *s)
{
    size_t l = strlen(s);
    if (b->n + l + 1 > b->cap) {
        b->cap = (b->n + l + 1) * 2;
        b->d = dbox_realloc(b->d, b->cap);
    }
    memcpy(b->d + b->n, s, l + 1);
    b->n += l;
}

static void sb_field(sbuf_t *b, const char *raw)
{
    if (!raw) raw = "";
    size_t n = strlen(raw);
    size_t need = ((n + 2) / 3) * 4 + 1;
    char *tmp = dbox_malloc(need);
    dbox_b64encode((const unsigned char *)raw, n, tmp);
    sb_add(b, tmp);
    dbox_free(tmp);
}

char *dbox_cfg_encode(const dbox_policy_t *p)
{
    sbuf_t b = {0};
    char line[256];

    snprintf(line, sizeof line, "V 1\n");
    sb_add(&b, line);
    snprintf(line, sizeof line, "P %d %d %d %d %d %d\n",
             (int)p->default_perm, p->net_mode, p->system_read,
             p->ask_timeout_ms, p->cache_ttl_s, p->grant_ttl_s);
    sb_add(&b, line);

    sb_add(&b, "E ");
    sb_field(&b, p->ask_endpoint);
    sb_add(&b, "\n");

    if (p->ask_token && p->ask_token[0]) {
        sb_add(&b, "T ");
        sb_field(&b, p->ask_token);
        sb_add(&b, "\n");
    }

    for (int i = 0; i < p->nrules; i++) {
        char tail[64];
        sb_add(&b, "L ");
        sb_field(&b, p->rules[i].path);
        snprintf(tail, sizeof tail, " %d %d\n", p->rules[i].acc, (int)p->rules[i].perm);
        sb_add(&b, tail);
    }
    if (!b.d) return dbox_strdup("");

    /* wrap the whole blob in base64 */
    size_t need = ((b.n + 2) / 3) * 4 + 1;
    char *out = dbox_malloc(need);
    dbox_b64encode((const unsigned char *)b.d, b.n, out);
    dbox_free(b.d);
    return out;
}

int dbox_cfg_decode(const char *b64, dbox_policy_t *p)
{
    size_t n = 0;
    unsigned char *blob = dbox_b64decode(b64, &n);
    if (!blob) return -1;
    char *text = dbox_malloc(n + 1);
    memcpy(text, blob, n);
    text[n] = '\0';
    dbox_free(blob);

    int rc = -1;
    char *save = NULL;    for (char *line = strtok_r(text, "\n", &save); line;
         line = strtok_r(NULL, "\n", &save)) {
        char tag = line[0];
        char *sp = tag ? strchr(line + 1, ' ') : NULL;
        if (sp) *sp = '\0';
        char *f1 = sp ? sp + 1 : NULL;
        char *f2 = NULL, *f3 = NULL, *f4 = NULL, *f5 = NULL, *f6 = NULL;
        if (f1) {
            f2 = strchr(f1, ' '); if (f2) { *f2 = '\0'; f2++; }
            f3 = f2 ? strchr(f2, ' ') : NULL; if (f3) { *f3 = '\0'; f3++; }
            f4 = f3 ? strchr(f3, ' ') : NULL; if (f4) { *f4 = '\0'; f4++; }
            f5 = f4 ? strchr(f4, ' ') : NULL; if (f5) { *f5 = '\0'; f5++; }
            f6 = f5 ? strchr(f5, ' ') : NULL; if (f6) { *f6 = '\0'; f6++; }
        }
        switch (tag) {
        case 'V':
            if (f1 && strcmp(f1, "1") == 0) rc = 0;
            goto next;
        case 'P':
            if (f6) {
                p->default_perm   = (dperm_t)atoi(f1);
                p->net_mode       = atoi(f2);
                p->system_read    = atoi(f3);
                p->ask_timeout_ms = atoi(f4);
                p->cache_ttl_s    = atoi(f5);
                p->grant_ttl_s    = atoi(f6);
                rc = 0;
            }
            goto next;
        case 'E':
            {
                size_t el = 0;
                unsigned char *ed = f1 ? dbox_b64decode(f1, &el) : NULL;
                if (ed) {
                    dbox_free(p->ask_endpoint);
                    p->ask_endpoint = dbox_malloc(el + 1);
                    memcpy(p->ask_endpoint, ed, el);
                    p->ask_endpoint[el] = '\0';
                    dbox_free(ed);
                    rc = 0;
                }
            }
            goto next;
        case 'L':
            {
                size_t ll = 0;
                unsigned char *ld = f3 ? dbox_b64decode(f1, &ll) : NULL;
                if (ld) {
                    p->rules = dbox_realloc(p->rules,
                        sizeof(dbox_rule_t) * (size_t)(p->nrules + 1));
                    p->rules[p->nrules].path = dbox_malloc(ll + 1);
                    memcpy(p->rules[p->nrules].path, ld, ll);
                    p->rules[p->nrules].path[ll] = '\0';
                    p->rules[p->nrules].acc = atoi(f2);
                    p->rules[p->nrules].perm = (dperm_t)atoi(f3);
                    p->nrules++;
                    dbox_free(ld);
                    rc = 0;
                }
            }
            goto next;
        case 'T':
            {
                size_t tl = 0;
                unsigned char *td = f1 ? dbox_b64decode(f1, &tl) : NULL;
                if (td) {
                    dbox_free(p->ask_token);
                    p->ask_token = dbox_malloc(tl + 1);
                    memcpy(p->ask_token, td, tl);
                    p->ask_token[tl] = '\0';
                    dbox_free(td);
                    rc = 0;
                }
            }
            goto next;
        default:
            goto next;
        }
    next:;
    }
    dbox_free(text);
    return rc;
}
