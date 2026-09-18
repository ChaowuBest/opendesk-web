/* mini_toml.c — minimal TOML subset parser (counterpart of MiniToml.cs) */
#define _GNU_SOURCE
#include "mini_toml.h"
#include "util.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <ctype.h>

typedef struct {
    const char *p;
    int line;
    char *err; size_t errsz;
    int failed;
} parser_t;

static void perr(parser_t *ps, const char *msg)
{
    if (!ps->failed) {
        ps->failed = 1;
        snprintf(ps->err, ps->errsz, "TOML line %d: %s", ps->line, msg);
    }
}

static void skip_ws(parser_t *ps)
{
    while (*ps->p == ' ' || *ps->p == '\t') ps->p++;
}

static void skip_comment(parser_t *ps)
{
    if (*ps->p == '#') { while (*ps->p && *ps->p != '\n') ps->p++; }
}

static void skip_to_eol(parser_t *ps)
{
    skip_ws(ps);
    skip_comment(ps);
    if (*ps->p == '\r') ps->p++;
    if (*ps->p == '\n') { ps->p++; ps->line++; }
    else if (*ps->p) perr(ps, "expected end of line");
}

static int is_bare(char c)
{
    return isalnum((unsigned char)c) || c == '_' || c == '-';
}

static char *parse_basic_string(parser_t *ps)
{
    /* at opening quote */
    ps->p++;
    size_t cap = 32, len = 0;
    char *r = dbox_malloc(cap);
    while (*ps->p && *ps->p != '"') {
        char c = *ps->p;
        if (c == '\n') { perr(ps, "unterminated string"); dbox_free(r); return NULL; }
        if (c == '\\') {
            ps->p++;
            switch (*ps->p) {
            case 'n': c = '\n'; break;
            case 't': c = '\t'; break;
            case 'r': c = '\r'; break;
            case '"': c = '"';  break;
            case '\\': c = '\\'; break;
            case '\0': perr(ps, "unterminated escape"); dbox_free(r); return NULL;
            default: perr(ps, "unsupported escape in string"); dbox_free(r); return NULL;
            }
            ps->p++;
        } else {
            ps->p++;
        }
        if (len + 2 > cap) { cap *= 2; r = dbox_realloc(r, cap); }
        r[len++] = c;
    }
    if (*ps->p != '"') { perr(ps, "unterminated string"); dbox_free(r); return NULL; }
    ps->p++;
    r[len] = '\0';
    return r;
}

static void add_entry(tdoc_t *doc, tentry_t e)
{
    if (doc->n == doc->cap) {
        doc->cap = doc->cap ? doc->cap * 2 : 32;
        doc->e = dbox_realloc(doc->e, sizeof(tentry_t) * doc->cap);
    }
    doc->e[doc->n++] = e;
}

int mini_toml_parse(const char *text, tdoc_t *doc, char *err, size_t errsz)
{
    memset(doc, 0, sizeof(*doc));
    parser_t ps = { .p = text, .line = 1, .err = err, .errsz = errsz };
    /* accept UTF-8 BOM (Windows-authored files often carry one) */
    if ((unsigned char)ps.p[0] == 0xEF && (unsigned char)ps.p[1] == 0xBB &&
        (unsigned char)ps.p[2] == 0xBF)
        ps.p += 3;
    char section[128] = "";
    int aot_index = -1;

    while (*ps.p && !ps.failed) {
        skip_ws(&ps);
        if (!*ps.p) break;
        if (*ps.p == '\n') { ps.p++; ps.line++; continue; }
        if (*ps.p == '\r') { ps.p++; continue; }
        if (*ps.p == '#') { skip_comment(&ps); continue; }

        if (*ps.p == '[') {
            int is_aot = 0;
            ps.p++;
            if (*ps.p == '[') { is_aot = 1; ps.p++; }
            skip_ws(&ps);
            char name[128]; size_t nl = 0;
            while (is_bare(*ps.p)) {
                if (nl + 1 >= sizeof(name)) { perr(&ps, "section name too long"); break; }
                name[nl++] = *ps.p++;
            }
            name[nl] = '\0';
            skip_ws(&ps);
            if (is_aot) {
                if (*ps.p != ']' || ps.p[1] != ']') { perr(&ps, "expected ]]"); continue; }
                ps.p += 2;
            } else {
                if (*ps.p != ']') { perr(&ps, "expected ]"); continue; }
                ps.p++;
            }
            snprintf(section, sizeof(section), "%s", name);
            if (is_aot) {
                /* count previous [[name]] occurrences */
                aot_index = 0;
                for (int i = 0; i < doc->n; i++)
                    if (doc->e[i].aot_index >= 0 && strcmp(doc->e[i].section, name) == 0)
                        aot_index = doc->e[i].aot_index + 1 > aot_index ? doc->e[i].aot_index + 1 : aot_index;
            } else {
                aot_index = -1;
            }
            skip_to_eol(&ps);
            continue;
        }

        /* key = value */
        char key[128]; size_t kl = 0;
        while (is_bare(*ps.p)) {
            if (kl + 1 >= sizeof(key)) { perr(&ps, "key too long"); break; }
            key[kl++] = *ps.p++;
        }
        key[kl] = '\0';
        if (!kl) { perr(&ps, "expected key"); continue; }
        skip_ws(&ps);
        if (*ps.p != '=') { perr(&ps, "expected '='"); continue; }
        ps.p++;
        skip_ws(&ps);

        tentry_t e;
        memset(&e, 0, sizeof(e));
        e.section = dbox_strdup(section);
        e.aot_index = aot_index;
        e.key = dbox_strdup(key);
        if (*ps.p == '"') {
            e.type = TV_STR;
            e.s = parse_basic_string(&ps);
            if (!e.s) { perr(&ps, "bad string value"); continue; }
        } else if (strncmp(ps.p, "true", 4) == 0) {
            e.type = TV_BOOL; e.b = 1; ps.p += 4;
        } else if (strncmp(ps.p, "false", 5) == 0) {
            e.type = TV_BOOL; e.b = 0; ps.p += 5;
        } else if (*ps.p == '+' || *ps.p == '-' || isdigit((unsigned char)*ps.p)) {
            char *end;
            e.type = TV_INT;
            e.i = strtol(ps.p, &end, 10);
            if (end == ps.p) { perr(&ps, "bad integer"); continue; }
            ps.p = end;
        } else {
            perr(&ps, "unsupported value (only strings, integers, booleans)");
            continue;
        }
        add_entry(doc, e);
        skip_to_eol(&ps);
    }

    if (ps.failed) { mini_toml_free(doc); return -1; }
    return 0;
}

const tentry_t *mini_toml_find(const tdoc_t *d, const char *section,
                               int aot_index, const char *key)
{
    for (int i = 0; i < d->n; i++) {
        const tentry_t *e = &d->e[i];
        if (strcmp(e->section, section) != 0) continue;
        if (e->aot_index != aot_index) continue;
        if (strcmp(e->key, key) != 0) continue;
        return e;
    }
    return NULL;
}

void mini_toml_free(tdoc_t *doc)
{
    for (int i = 0; i < doc->n; i++) {
        dbox_free(doc->e[i].section);
        dbox_free(doc->e[i].key);
        if (doc->e[i].type == TV_STR) dbox_free(doc->e[i].s);
    }
    dbox_free(doc->e);
    memset(doc, 0, sizeof(*doc));
}
