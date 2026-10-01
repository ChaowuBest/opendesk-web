/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

//! 策略引擎：TOML 规则加载、glob 匹配、访问类别分解、ask 决策（HTTP 传输、
//! 决策缓存、子树授权 grants）、全链路 fail-closed。
//! 移植自 Windows dynobox 的 `Policy.cs`，路径语义改为 Linux 绝对路径（透明路径）。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::net::ToSocketAddrs;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const ACC_READ: u8 = 1;
pub const ACC_WRITE: u8 = 2;
pub const ACC_EXECUTE: u8 = 4;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Perm {
    Allow,
    Ask,
    Deny,
}

impl Perm {
    fn parse(value: &str) -> Option<Perm> {
        match value {
            "allow" => Some(Perm::Allow),
            "ask" => Some(Perm::Ask),
            "deny" => Some(Perm::Deny),
            _ => None,
        }
    }
}

fn parse_access(value: &str) -> Option<u8> {
    match value {
        "read" => Some(ACC_READ),
        "write" => Some(ACC_WRITE),
        "execute" => Some(ACC_EXECUTE),
        "all" => Some(ACC_READ | ACC_WRITE | ACC_EXECUTE),
        _ => None,
    }
}

#[derive(serde::Deserialize)]
struct AskFile {
    endpoint: Option<String>,
    token: Option<String>,
    timeout_ms: Option<u64>,
    cache_ttl_seconds: Option<u64>,
    grant_ttl_seconds: Option<u64>,
}

#[derive(serde::Deserialize)]
struct RootFile {
    #[serde(rename = "virtual")]
    virtual_path: String,
    #[serde(rename = "real")]
    real_path: String,
}

#[derive(serde::Deserialize)]
struct RuleFile {
    path: String,
    access: String,
    perm: String,
}

#[derive(serde::Deserialize)]
struct PolicyFile {
    #[allow(dead_code)]
    version: Option<u32>,
    default: Option<String>,
    ask: Option<AskFile>,
    #[serde(default)]
    roots: Vec<RootFile>,
    #[serde(default)]
    rules: Vec<RuleFile>,
}

#[derive(Clone)]
pub struct AskConfig {
    pub endpoint: String,
    pub token: Option<String>,
    pub timeout_ms: u64,
    pub cache_ttl_seconds: u64,
    pub grant_ttl_seconds: u64,
}

/// 透明路径模式下 roots[].virtual_path 即 FUSE 挂载点（与宿主同路径），
/// roots[].real_path 是管理进程直接访问的镜像源。
#[derive(Clone, Debug)]
pub struct Root {
    pub virtual_path: String,
    pub real_path: String,
}

struct Rule {
    segments: Vec<String>,
    access: u8,
    perm: Perm,
    raw_path: String,
}

struct Grant {
    segments: Vec<String>,
    access: u8,
    expires: Instant,
}

struct CacheEntry {
    allow: bool,
    expires: Instant,
}

pub struct Policy {
    pub default: Perm,
    pub ask: AskConfig,
    pub roots: Vec<Root>,
    rules: Vec<Rule>,
    grants: Mutex<Vec<Grant>>,
    cache: Mutex<HashMap<(String, u8), CacheEntry>>,
}

/// 归一化绝对路径：折叠重复 `/`、去掉末尾 `/`（根保留为空段列表）、拒绝 `..` 与
/// 控制字符。返回 None 表示路径非法（调用方按 deny 处理，fail-closed）。
pub fn normalize(path: &str) -> Option<Vec<String>> {
    if path.chars().any(|c| (c as u32) < 32) {
        return None;
    }
    if !path.starts_with('/') {
        return None;
    }
    let mut segments: Vec<String> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => continue,
            ".." => return None,
            other => segments.push(other.to_string()),
        }
    }
    Some(segments)
}

fn match_segment(pattern: &str, text: &str) -> bool {
    // 段内 glob：`*` 匹配任意序列，`?` 匹配单字符，双指针贪心回溯
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            mark = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// pattern 段序列匹配 path 段序列；`**` 段跨层级（匹配 0..n 段）。
fn glob_match(pattern: &[String], path: &[String]) -> bool {
    glob_match_at(pattern, 0, path, 0)
}

fn glob_match_at(pattern: &[String], pi: usize, path: &[String], si: usize) -> bool {
    if pi == pattern.len() {
        return si == path.len();
    }
    if pattern[pi] == "**" {
        // 跨层级：尝试消耗 0..n 段
        for skip in si..=path.len() {
            if glob_match_at(pattern, pi + 1, path, skip) {
                return true;
            }
        }
        return false;
    }
    if si == path.len() {
        return false;
    }
    if match_segment(&pattern[pi], &path[si]) {
        return glob_match_at(pattern, pi + 1, path, si + 1);
    }
    false
}

impl Policy {
    pub fn load(policy_path: &str) -> Result<Policy, String> {
        let text = std::fs::read_to_string(policy_path)
            .map_err(|e| format!("无法读取策略文件 {policy_path}: {e}"))?;
        let file: PolicyFile = toml::from_str(&text).map_err(|e| format!("策略文件解析失败: {e}"))?;
        let default = file
            .default
            .as_deref()
            .and_then(Perm::parse)
            .unwrap_or(Perm::Deny);
        let ask_file = file.ask.unwrap_or(AskFile {
            endpoint: None,
            token: None,
            timeout_ms: None,
            cache_ttl_seconds: None,
            grant_ttl_seconds: None,
        });
        let ask = AskConfig {
            endpoint: ask_file.endpoint.unwrap_or_default(),
            token: ask_file.token,
            timeout_ms: ask_file.timeout_ms.unwrap_or(2000),
            cache_ttl_seconds: ask_file.cache_ttl_seconds.unwrap_or(60),
            grant_ttl_seconds: ask_file.grant_ttl_seconds.unwrap_or(300),
        };
        let mut roots = Vec::new();
        for root in file.roots {
            let virtual_path = root.virtual_path.trim_end_matches('/').to_string();
            let virtual_path = if virtual_path.is_empty() {
                "/".to_string()
            } else {
                virtual_path
            };
            roots.push(Root {
                virtual_path,
                real_path: root.real_path,
            });
        }
        let mut rules = Vec::new();
        for rule in file.rules {
            let access = parse_access(&rule.access)
                .ok_or_else(|| format!("规则 access 非法: {}", rule.access))?;
            let perm =
                Perm::parse(&rule.perm).ok_or_else(|| format!("规则 perm 非法: {}", rule.perm))?;
            let segments = normalize(&rule.path)
                .ok_or_else(|| format!("规则 path 非法: {}", rule.path))?;
            rules.push(Rule {
                segments,
                access,
                perm,
                raw_path: rule.path,
            });
        }
        Ok(Policy {
            default,
            ask,
            roots,
            rules,
            grants: Mutex::new(Vec::new()),
            cache: Mutex::new(HashMap::new()),
        })
    }

    /// 一次访问判定。任一环节失败（非法路径、ask 超时/不可达/坏响应）一律拒绝。
    pub fn check(&self, path: &str, access: u8) -> bool {
        let segments = match normalize(path) {
            Some(s) => s,
            None => return false,
        };
        // 组合类别（如 O_RDWR 的 read|write）拆分为单类别逐一判定：任一类别被拒
        // 即整体拒绝。仅按首条相交规则判定会让 O_RDWR 经 read 规则放行而绕过
        // write deny（对齐 Windows 版 MirrorFs.Check 的逐类别语义）。
        let mut allowed = true;
        for bit in [ACC_READ, ACC_WRITE, ACC_EXECUTE] {
            if access & bit != 0 && !self.check_kind(&segments, bit) {
                allowed = false;
            }
        }
        allowed
    }

    /// 单类别判定（首条命中规则生效；未命中规则按 default）
    fn check_kind(&self, segments: &[String], access: u8) -> bool {
        for rule in &self.rules {
            if rule.access & access == 0 {
                continue;
            }
            if glob_match(&rule.segments, segments) {
                match rule.perm {
                    Perm::Allow => return true,
                    Perm::Deny => return false,
                    Perm::Ask => return self.ask_decide(segments, access),
                }
            }
        }
        match self.default {
            Perm::Allow => true,
            Perm::Deny => false,
            Perm::Ask => self.ask_decide(segments, access),
        }
    }

    pub fn check_exec(&self, path: &str) -> bool {
        self.check(path, ACC_EXECUTE)
    }

    fn grant_hit(&self, segments: &[String], access: u8) -> bool {
        let now = Instant::now();
        let mut grants = self.grants.lock().unwrap();
        grants.retain(|g| g.expires > now);
        grants
            .iter()
            .any(|g| g.access & access != 0 && glob_match(&g.segments, segments))
    }

    /// 单实例 grants 数量上限：防止恶意/异常端点海量下发授权导致内存与匹配开销失控
    const MAX_GRANTS: usize = 1024;

    /// 决策缓存条目上限（与 MAX_GRANTS 同款约束）：防异常端点对不同路径海量
    /// allow 导致缓存无界增长。超出时仅保留已有条目（下次过期清理后再试）
    const MAX_CACHE_ENTRIES: usize = 4096;

    fn install_grants(&self, grants: &[serde_json::Value]) {
        let now = Instant::now();
        let mut installed = self.grants.lock().unwrap();
        // 先清理过期，再检查容量
        installed.retain(|g| g.expires > now);
        for grant in grants {
            if installed.len() >= Self::MAX_GRANTS {
                break;
            }
            let path = match grant.get("path").and_then(|v| v.as_str()) {
                Some(p) => p,
                None => continue,
            };
            let segments = match normalize(path) {
                Some(s) => s,
                None => continue,
            };
            let access = match grant.get("access").and_then(|v| v.as_str()) {
                Some("read") => ACC_READ,
                Some("write") => ACC_WRITE,
                Some("execute") => ACC_EXECUTE,
                Some("all") => ACC_READ | ACC_WRITE | ACC_EXECUTE,
                _ => continue,
            };
            let ttl = grant
                .get("ttl")
                .and_then(|v| v.as_u64())
                .unwrap_or(self.ask.grant_ttl_seconds)
                .min(3600);
            installed.push(Grant {
                segments,
                access,
                expires: now + Duration::from_secs(ttl),
            });
        }
    }

    fn ask_decide(&self, segments: &[String], access: u8) -> bool {
        if self.grant_hit(segments, access) {
            return true;
        }
        // 规范路径（折叠重复斜杠/`.`、去尾斜杠）：保证缓存 key 与端点请求一致
        let canonical = if segments.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", segments.join("/"))
        };
        let key = (canonical.clone(), access);
        if self.ask.cache_ttl_seconds > 0 {
            let now = Instant::now();
            if let Some(entry) = self.cache.lock().unwrap().get(&key) {
                if entry.expires > now {
                    return entry.allow;
                }
            }
        }
        // 组合类别（O_RDWR 的 read|write）按更敏感的 write 上报：历史实现落入
        // `_ => "execute"` 分支，TS 端点按 execute 询问可能被宽泛 execute 规则
        // 静默放行，绕过写授权弹窗
        let access_name = if access & ACC_WRITE != 0 {
            "write"
        } else if access & ACC_READ != 0 {
            "read"
        } else {
            "execute"
        };
        let body = serde_json::json!({ "path": canonical, "access": access_name });
        // 超时/不可达/非 200/字段缺失 → deny 且不进缓存（fail-closed）
        let response = match self.post_decide(&body.to_string()) {
            Ok(r) => r,
            Err(_) => return false,
        };
        let value: serde_json::Value = match serde_json::from_str(&response) {
            Ok(v) => v,
            Err(_) => return false,
        };
        let decision = value.get("decision").and_then(|v| v.as_str());
        let allow = match decision {
            Some("allow") => true,
            Some("deny") => false,
            _ => return false,
        };
        // 仅 allow 时安装 grants：deny 响应携带的 grants 若被安装，后续同子树
        // 访问经 grant_hit 直接放行（grant_hit 优先于端点询问）——"虚假拒绝 +
        // 后门授权"可绕过端点决策（fail-closed）
        if allow {
            if let Some(grants) = value.get("grants").and_then(|v| v.as_array()) {
                self.install_grants(grants);
            }
        }
        if allow && self.ask.cache_ttl_seconds > 0 {
            let now = Instant::now();
            let mut cache = self.cache.lock().unwrap();
            // 插入前清理过期条目，防止缓存无界增长（决策缓存多为临时写入）
            cache.retain(|_, entry| entry.expires > now);
            if cache.len() < Self::MAX_CACHE_ENTRIES {
                cache.insert(
                    key,
                    CacheEntry {
                        allow,
                        expires: now + Duration::from_secs(self.ask.cache_ttl_seconds),
                    },
                );
            }
        }
        allow
    }

    fn post_decide(&self, body: &str) -> Result<String, String> {
        let url = &self.ask.endpoint;
        let rest = url.strip_prefix("http://").ok_or("仅支持 http:// 端点")?;
        let (authority, path) = match rest.find('/') {
            Some(index) => (&rest[..index], &rest[index..]),
            None => (rest, "/"),
        };
        let address = if authority.contains(':') {
            authority.to_string()
        } else {
            format!("{authority}:80")
        };
        if !authority
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '-' | '_' | '[' | ']'))
        {
            return Err("端点 authority 含非法字符".to_string());
        }
        // 解析后 connect_timeout：端点 IP 不可达（黑洞路由）时受 timeout_ms 约束，
        // 而非系统默认 TCP 连接超时（~2min，期间单线程 FUSE 会话整体冻结）
        let timeout = Duration::from_millis(self.ask.timeout_ms.max(1));
        let mut last_error: Option<std::io::Error> = None;
        let mut stream: Option<TcpStream> = None;
        let addrs = address
            .to_socket_addrs()
            .map_err(|e| format!("解析端点地址失败: {e}"))?;
        for addr in addrs {
            match TcpStream::connect_timeout(&addr, timeout) {
                Ok(s) => {
                    stream = Some(s);
                    break;
                }
                Err(e) => last_error = Some(e),
            }
        }
        let mut stream =
            stream.ok_or_else(|| format!("连接端点失败: {}", last_error.map(|e| e.to_string()).unwrap_or_default()))?;
        stream.set_read_timeout(Some(timeout)).ok();
        stream.set_write_timeout(Some(timeout)).ok();
        // 用 HTTP/1.0：不支持 chunked 传输，端点为满足 Content-Length 响应（或连接
        // 关闭）；避免手写客户端需要解码 chunked。
        let mut request = format!(
            "POST {path} HTTP/1.0\r\nHost: {authority}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            self.ask.token.as_deref().unwrap_or(""),
            body.len()
        );
        request.push_str(body);
        stream
            .write_all(request.as_bytes())
            .map_err(|e| format!("发送请求失败: {e}"))?;
        let mut raw = Vec::new();
        // 限制响应大小（1 MiB 内），防异常端点导致内存膨胀
        let mut chunk = [0u8; 4096];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    raw.extend_from_slice(&chunk[..n]);
                    if raw.len() > 1 << 20 {
                        return Err("端点响应过大".to_string());
                    }
                }
                Err(e) => return Err(format!("读取响应失败: {e}")),
            }
        }
        let text = String::from_utf8_lossy(&raw).to_string();
        // 头/体分隔：优先 \r\n\r\n（标准 HTTP），兼容仅 \n\n 的非标准端点
        let (head, payload) = text
            .split_once("\r\n\r\n")
            .or_else(|| text.split_once("\n\n"))
            .ok_or("响应缺少头部分隔")?;
        let status = head
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .ok_or("响应缺少状态行")?;
        if status != "200" {
            return Err(format!("端点返回 {status}"));
        }
        Ok(payload.to_string())
    }

    #[allow(dead_code)]
    pub fn debug_rules(&self) {
        println!("default={:?}", self.default);
        for rule in &self.rules {
            println!(
                "  rule path={} access={} perm={:?}",
                rule.raw_path, rule.access, rule.perm
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segs(path: &str) -> Vec<String> {
        normalize(path).unwrap()
    }

    #[test]
    fn normalize_rejects_traversal() {
        assert!(normalize("/a/../b").is_none());
        assert_eq!(segs("/a//b/./c"), vec!["a", "b", "c"]);
        assert!(segs("/").is_empty());
    }

    #[test]
    fn glob_star_single_level() {
        let p = segs("/docs/*/x");
        assert!(glob_match(&p, &segs("/docs/a/x")));
        assert!(!glob_match(&p, &segs("/docs/a/b/x")));
    }

    #[test]
    fn glob_double_star_crosses_levels_and_matches_self() {
        let p = segs("/docs/**");
        assert!(glob_match(&p, &segs("/docs")));
        assert!(glob_match(&p, &segs("/docs/a/b/c.txt")));
        let root = segs("/**");
        assert!(glob_match(&root, &[]));
        assert!(glob_match(&root, &segs("/etc/passwd")));
    }

    #[test]
    fn glob_question_mark() {
        let p = segs("/a?.txt");
        assert!(glob_match(&p, &segs("/ab.txt")));
        assert!(!glob_match(&p, &segs("/abc.txt")));
    }

    #[test]
    fn default_ask_falls_back_to_endpoint() {
        // default="ask"：未命中规则时按 ask_decide 判定（而非静默 deny）
        use std::io::Write;
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf).unwrap();
            let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{\"decision\":\"allow\"}";
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        });
        let policy = Policy {
            default: Perm::Ask,
            ask: AskConfig {
                endpoint: format!("http://127.0.0.1:{port}/decide"),
                token: None,
                timeout_ms: 2000,
                cache_ttl_seconds: 0,
                grant_ttl_seconds: 300,
            },
            roots: vec![],
            rules: vec![],
            grants: Mutex::new(Vec::new()),
            cache: Mutex::new(HashMap::new()),
        };
        assert!(policy.check("/work/anything.txt", ACC_READ));
    }

    #[test]
    fn check_uses_canonical_path_for_ask_body_and_cache_key() {
        use std::io::Write;
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // 端点线程：accept 一次请求后返回收到的请求文本。注意 join 必须放在
        // check 之后（否则端点等连接、主线程等线程，双方互等死锁）。
        let endpoint_handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{\"decision\":\"allow\"}";
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
            req
        });
        let policy = Policy {
            default: Perm::Deny,
            ask: AskConfig {
                endpoint: format!("http://127.0.0.1:{port}/decide"),
                token: None,
                timeout_ms: 2000,
                cache_ttl_seconds: 60,
                grant_ttl_seconds: 300,
            },
            roots: vec![],
            rules: vec![Rule {
                segments: segs("/work/**"),
                access: ACC_READ,
                perm: Perm::Ask,
                raw_path: "/work/**".into(),
            }],
            grants: Mutex::new(Vec::new()),
            cache: Mutex::new(HashMap::new()),
        };
        // 不同写法的同一路径（折叠重复斜杠/`.`）：规范化后同一缓存 key，
        // 第二次命中缓存不再发请求（端点只 accept 一次）
        assert!(policy.check("/work//a/b.txt", ACC_READ));
        assert!(policy.check("/work/a/b.txt", ACC_READ));
        let received = endpoint_handle.join().unwrap();
        assert!(received.contains("/work/a/b.txt"));
        assert!(!received.contains(".."));
        assert!(policy.cache.lock().unwrap().contains_key(&("/work/a/b.txt".to_string(), ACC_READ)));
    }

    #[test]
    fn grants_expire_and_are_pruned() {
        let policy = Policy {
            default: Perm::Deny,
            ask: AskConfig {
                endpoint: String::new(),
                token: None,
                timeout_ms: 2000,
                cache_ttl_seconds: 0,
                grant_ttl_seconds: 0,
            },
            roots: vec![],
            rules: vec![],
            grants: Mutex::new(Vec::new()),
            cache: Mutex::new(HashMap::new()),
        };
        let grant = Grant {
            segments: segs("/work/scratch/**"),
            access: ACC_WRITE,
            expires: Instant::now(),
        };
        policy.grants.lock().unwrap().push(grant);
        // TTL=0 → 立即过期：grant_hit 应清理并返回 false
        assert!(!policy.grant_hit(&segs("/work/scratch/x.txt"), ACC_WRITE));
        assert!(policy.grants.lock().unwrap().is_empty());
    }

    fn mk_rule(path: &str, access: u8, perm: Perm) -> Rule {
        Rule {
            segments: segs(path),
            access,
            perm,
            raw_path: path.to_string(),
        }
    }

    fn mk_policy(default: Perm, rules: Vec<Rule>, endpoint: &str) -> Policy {
        Policy {
            default,
            ask: AskConfig {
                endpoint: endpoint.to_string(),
                token: None,
                timeout_ms: 1000,
                cache_ttl_seconds: 0,
                grant_ttl_seconds: 300,
            },
            roots: vec![],
            rules,
            grants: Mutex::new(Vec::new()),
            cache: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn check_fail_closed_on_invalid_path() {
        let policy = mk_policy(Perm::Allow, vec![], "");
        // 非法路径（穿越/控制字符）一律拒绝（fail-closed），即使 default=allow
        assert!(!policy.check("/a/../b", ACC_READ));
        assert!(!policy.check("/a\0b", ACC_READ));
        assert!(!policy.check("relative/path", ACC_READ));
    }

    #[test]
    fn rule_order_specific_before_wildcard() {
        // 具体 deny 在前、宽泛 allow 在后：首条命中生效
        let policy = mk_policy(
            Perm::Deny,
            vec![
                mk_rule("/docs/secret.txt", ACC_READ | ACC_WRITE | ACC_EXECUTE, Perm::Deny),
                mk_rule("/docs/**", ACC_READ, Perm::Allow),
                mk_rule("/**", ACC_READ | ACC_WRITE | ACC_EXECUTE, Perm::Allow),
            ],
            "",
        );
        assert!(!policy.check("/docs/secret.txt", ACC_READ));
        assert!(policy.check("/docs/other.txt", ACC_READ));
        assert!(!policy.check("/docs/secret.txt", ACC_WRITE));
    }

    #[test]
    fn access_bits_filter_unrelated_rules() {
        // 规则 access 与请求类别无交集时跳过（write 规则不影响 read 求值）
        let policy = mk_policy(
            Perm::Deny,
            vec![mk_rule("/only/**", ACC_WRITE, Perm::Allow)],
            "",
        );
        assert!(!policy.check("/only/a.txt", ACC_READ)); // read 无规则 → default deny
        assert!(policy.check("/only/a.txt", ACC_WRITE)); // write 命中 allow
    }

    #[test]
    fn all_access_covers_rw_e() {
        let policy = mk_policy(
            Perm::Deny,
            vec![mk_rule("/open/**", ACC_READ | ACC_WRITE | ACC_EXECUTE, Perm::Allow)],
            "",
        );
        assert!(policy.check("/open/a", ACC_READ));
        assert!(policy.check("/open/a", ACC_WRITE));
        assert!(policy.check_exec("/open/a"));
        assert!(policy.check("/open/a", ACC_EXECUTE));
    }

    #[test]
    fn default_deny_and_allow_semantics() {
        let deny = mk_policy(Perm::Deny, vec![], "");
        assert!(!deny.check("/anything", ACC_READ));
        let allow = mk_policy(Perm::Allow, vec![], "");
        assert!(allow.check("/anything", ACC_READ));
    }

    #[test]
    fn grant_matches_subtree_only() {
        let policy = mk_policy(Perm::Deny, vec![], "");
        let grant = Grant {
            segments: segs("/staging/**"),
            access: ACC_WRITE,
            expires: Instant::now() + Duration::from_secs(60),
        };
        policy.grants.lock().unwrap().push(grant);
        assert!(policy.grant_hit(&segs("/staging/a/b.txt"), ACC_WRITE));
        assert!(policy.grant_hit(&segs("/staging"), ACC_WRITE));
        assert!(!policy.grant_hit(&segs("/stage/x.txt"), ACC_WRITE));
        assert!(!policy.grant_hit(&segs("/staging/a.txt"), ACC_READ)); // 类别不匹配
    }

    #[test]
    fn normalize_rejects_control_chars() {
        assert!(normalize("/ok.txt").is_some());
        assert!(normalize("/a\tb").is_none());
        assert!(normalize("/a\nb").is_none());
        assert!(normalize("").is_none());
    }

    #[test]
    fn policy_load_rejects_bad_perm_and_relative_path() {
        let file_bad_perm = std::env::temp_dir().join("bad-perm.toml");
        let file_rel = std::env::temp_dir().join("rel-rule.toml");
        let bad_perm = concat!("[[rules]]\n", "path = \"/x\"\n", "access = \"read\"\n", "perm = \"bogus\"\n");
        let rel_rule = concat!("[[rules]]\n", "path = \"relative/x\"\n", "access = \"read\"\n", "perm = \"allow\"\n");
        std::fs::write(&file_bad_perm, bad_perm).unwrap();
        std::fs::write(&file_rel, rel_rule).unwrap();
        assert!(Policy::load(file_bad_perm.to_str().unwrap()).is_err());
        assert!(Policy::load(file_rel.to_str().unwrap()).is_err());
        let _ = std::fs::remove_file(&file_bad_perm);
        let _ = std::fs::remove_file(&file_rel);
    }

    #[test]
    fn ask_decide_allow_via_http() {
        use std::io::Write;
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap();
            let received = String::from_utf8_lossy(&buf[..n]).to_string();
            let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 96\r\nConnection: close\r\n\r\n{\"decision\":\"allow\",\"grants\":[{\"path\":\"/work/staging/**\",\"access\":\"write\",\"ttl\":120}]}";
            stream.write_all(resp.as_bytes()).unwrap();
            stream.flush().unwrap();
            received
        });
        let policy = Policy {
            default: Perm::Deny,
            ask: AskConfig {
                endpoint: format!("http://127.0.0.1:{port}/decide"),
                token: Some("t".to_string()),
                timeout_ms: 2000,
                cache_ttl_seconds: 0,
                grant_ttl_seconds: 300,
            },
            roots: vec![],
            rules: vec![],
            grants: Mutex::new(Vec::new()),
            cache: Mutex::new(HashMap::new()),
        };
        let ok = policy.ask_decide(&segs("/work/staging/x.txt"), ACC_WRITE);
        let received = thread.join().unwrap();
        assert!(ok, "ask allow 应返回 true; 端点收到: {received}");
        assert!(received.contains("POST /decide HTTP/1.0"));
        assert!(received.contains("Bearer t"));
        assert!(received.contains("/work/staging/x.txt"));
    }

    #[test]
    fn check_combined_access_requires_every_kind_allowed() {
        // 组合类别（O_RDWR 的 read|write）逐类别判定：read allow 不足以放行
        // 整体——write deny 必须仍然生效（历史首条相交规则判定会绕过）
        let policy = mk_policy(
            Perm::Deny,
            vec![
                mk_rule("/work/**", ACC_READ, Perm::Allow),
                mk_rule("/work/**", ACC_WRITE, Perm::Deny),
            ],
            "",
        );
        assert!(policy.check("/work/a.txt", ACC_READ));
        assert!(!policy.check("/work/a.txt", ACC_READ | ACC_WRITE));
        assert!(!policy.check("/work/a.txt", ACC_WRITE));
        // 全允许时组合位放行
        let policy2 = mk_policy(
            Perm::Deny,
            vec![mk_rule("/work/**", ACC_READ | ACC_WRITE, Perm::Allow)],
            "",
        );
        assert!(policy2.check("/work/a.txt", ACC_READ | ACC_WRITE));
    }

    #[test]
    fn ask_reports_write_for_combined_rw_access() {
        // O_RDWR 打开的组合 access（ACC_READ|ACC_WRITE）命中 write ask 规则时，
        // 端点收到的 access 必须是 "write"——历史上错报 "execute"，TS 端点的
        // execute 规则可能静默放行，绕过写授权弹窗。
        use std::io::Write;
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap();
            let received = String::from_utf8_lossy(&buf[..n]).to_string();
            let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{\"decision\":\"deny\"}";
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
            received
        });
        let policy = mk_policy(
            Perm::Deny,
            vec![mk_rule("/work/**", ACC_WRITE, Perm::Ask)],
            &format!("http://127.0.0.1:{port}/decide"),
        );
        // 组合位（O_RDWR 语义）：规则 access=write 与之有交集 → 命中 ask；端点拒 → deny
        assert!(!policy.check("/work/a.txt", ACC_READ | ACC_WRITE));
        let received = thread.join().unwrap();
        assert!(
            received.contains("\"access\":\"write\""),
            "端点应收到 write 类别: {received}"
        );
        assert!(
            !received.contains("\"access\":\"execute\""),
            "组合位不得错报为 execute: {received}"
        );
    }

    #[test]
    fn grants_from_deny_response_are_not_installed() {
        // deny 响应携带的 grants 不得安装：否则"虚假拒绝 + 后门授权"可经
        // grant_hit 绕过端点决策（历史实现不检查 decision 一律安装，与
        // Windows 版 Policy.cs 的同一缺陷一致）
        use std::io::Write;
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap();
            let received = String::from_utf8_lossy(&buf[..n]).to_string();
            let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 89\r\nConnection: close\r\n\r\n{\"decision\":\"deny\",\"grants\":[{\"path\":\"/work/staging/**\",\"access\":\"write\",\"ttl\":300}]}";
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
            received
        });
        let policy = mk_policy(Perm::Deny, vec![], &format!("http://127.0.0.1:{port}/decide"));
        assert!(!policy.ask_decide(&segs("/work/staging/x.txt"), ACC_WRITE));
        assert!(
            policy.grants.lock().unwrap().is_empty(),
            "deny 响应的 grants 不得被安装"
        );
        let _ = thread.join();
    }

    #[test]
    fn ask_connect_timeout_is_bounded() {
        // 端点 IP 不可路由（黑洞）：connect 必须受 timeout_ms 约束而非系统默认
        // TCP 连接超时（可达 ~2min），否则一次 ask 会冻结整个单线程 FUSE 会话
        let policy = mk_policy(Perm::Deny, vec![], "http://10.255.255.1:81/decide");
        let start = Instant::now();
        assert!(!policy.check("/work/x", ACC_READ));
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "connect 应受 timeout_ms 约束，实际耗时 {:?}",
            start.elapsed()
        );
    }
}
