/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

//! 内置参考决策端点（对齐 Windows DecisionEndpoint.cs）：测试与演示用。
//! 提供 HTTP POST /decide 与审计 GET /log。用 std TcpListener 手写，零依赖。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub fn run(port: u16, default_decision: &str) -> Result<i32, String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("监听 127.0.0.1:{port} 失败: {e}"))?;
    let default = if default_decision == "allow" { "allow" } else { "deny" };
    eprintln!("决策端点已启动: http://127.0.0.1:{port}/decide (default={default})");
    let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let _seq = AtomicUsize::new(0);
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                stream
                    .set_read_timeout(Some(Duration::from_secs(30)))
                    .ok();
                let default_owned = default.to_string();
                let log_owned = Arc::clone(&log);
                // 每连接独立线程处理：慢请求（/slow 8s）不阻塞其他决策请求
                std::thread::spawn(move || handle(stream, &default_owned, &log_owned));
            }
            Err(_) => break,
        }
    }
    Ok(0)
}

fn decide(path: &str, access: &str, default: &str) -> (String, Vec<(String, String)>) {
    let mut grants = Vec::new();
    if path.starts_with("/slow") {
        std::thread::sleep(Duration::from_secs(8));
        return ("deny".to_string(), grants);
    }
    if path.starts_with("/notes") {
        grants.push(("/notes/**".to_string(), "read".to_string()));
        return ("allow".to_string(), grants);
    }
    if path.starts_with("/scratch") {
        grants.push(("/scratch/**".to_string(), "all".to_string()));
        return ("allow".to_string(), grants);
    }
    if path.starts_with("/staging") && access == "write" {
        grants.push(("/staging/**".to_string(), "write".to_string()));
        return ("allow".to_string(), grants);
    }
    if path.starts_with("/reject") {
        return ("deny".to_string(), grants);
    }
    if path.starts_with("/guarded") {
        return ("allow".to_string(), grants); // 不下发授权：每次新路径重新问询
    }
    if path.starts_with("/tools/ask") {
        return ("allow".to_string(), grants);
    }
    (default.to_string(), grants)
}

fn handle(mut stream: TcpStream, default: &str, log: &Mutex<Vec<String>>) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buffer.extend_from_slice(&chunk[..n]);
                if buffer.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if buffer.len() > 1 << 20 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let request = String::from_utf8_lossy(&buffer).to_string();
    let head = request.split("\r\n\r\n").next().unwrap_or("");
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or("GET / HTTP/1.1");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let path = parts.next().unwrap_or("/");
    let body = request.split("\r\n\r\n").nth(1).unwrap_or("");
    let response = if path == "/health" {
        (200, r#"{"status":"ok"}"#.to_string())
    } else if path == "/log" {
        let entries = log.lock().unwrap().join("\n");
        (200, format!("[{entries}]"))
    } else if path == "/decide" && method == "POST" {
        let (req_path, req_access) = parse_decide_body(body);
        let (decision, grants) = decide(&req_path, &req_access, default);
        log.lock().unwrap().push(format!(
            r#"{{"path":"{}","access":"{}","decision":"{}"}}"#,
            req_path, req_access, decision
        ));
        let grants_json: Vec<String> = grants
            .iter()
            .map(|(p, a)| format!(r#"{{"path":"{p}","access":"{a}","ttl":120}}"#))
            .collect();
        (
            200,
            format!(r#"{{"decision":"{decision}","grants":[{}]}}"#, grants_json.join(",")),
        )
    } else {
        (404, r#"{"error":"not found"}"#.to_string())
    };
    let _ = write_response(&mut stream, response.0, &response.1);
}

fn parse_decide_body(body: &str) -> (String, String) {
    let mut path = "/".to_string();
    let mut access = "read".to_string();
    if let Some(json) = serde_json::from_str::<serde_json::Value>(body).ok() {
        if let Some(p) = json.get("path").and_then(|v| v.as_str()) {
            path = p.to_string();
        }
        if let Some(a) = json.get("access").and_then(|v| v.as_str()) {
            access = a.to_string();
        }
    }
    (path, access)
}

fn write_response(stream: &mut TcpStream, code: u16, body: &str) -> std::io::Result<()> {
    let status = match code {
        200 => "200 OK",
        404 => "404 Not Found",
        _ => "400 Bad Request",
    };
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}