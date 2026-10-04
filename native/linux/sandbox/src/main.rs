/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

//! dynobox-linux CLI 入口：run / debug-rules / detect（对齐 Windows dynobox 子命令）。

mod endpoint;
mod mirror_fs;
mod policy;
mod sandbox;

use std::sync::Arc;

fn usage() {
    println!(
        "用法:\n  dynobox-linux run --policy <rules.toml> [--upstream URL] [--cwd DIR] [--log-file FILE] [--del-to-trash] [--trash-dir DIR] [--ro-dirs P1,P2] -- <子进程命令行...>\n  dynobox-linux endpoint [--port P] [--default allow|deny]\n  dynobox-linux debug-rules --policy <rules.toml> [--path P] [--access K]\n  dynobox-linux detect\n\n示例:\n  dynobox-linux run --policy rules.toml --upstream http://127.0.0.1:8080/decide -- /usr/bin/bash -c 'echo hi'"
    );
}

fn parse_run_args(args: &[String]) -> (String, Option<String>, Option<String>, Option<String>, bool, Option<String>, Vec<String>) {
    let mut policy: Option<String> = None;
    let mut upstream: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut log_file: Option<String> = None;
    let mut del_to_trash = false;
    let mut trash_dir: Option<String> = None;
    let mut ro_dirs: Vec<String> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--policy" if index + 1 < args.len() => {
                policy = Some(args[index + 1].clone());
                index += 2;
            }
            "--upstream" if index + 1 < args.len() => {
                upstream = Some(args[index + 1].clone());
                index += 2;
            }
            "--cwd" if index + 1 < args.len() => {
                cwd = Some(args[index + 1].clone());
                index += 2;
            }
            "--log-file" if index + 1 < args.len() => {
                log_file = Some(args[index + 1].clone());
                index += 2;
            }
            "--del-to-trash" => {
                del_to_trash = true;
                index += 1;
            }
            "--trash-dir" if index + 1 < args.len() => {
                trash_dir = Some(args[index + 1].clone());
                index += 2;
            }
            "--ro-dirs" if index + 1 < args.len() => {
                ro_dirs = args[index + 1]
                    .split(',')
                    .map(|d| d.trim().to_string())
                    .filter(|d| !d.is_empty())
                    .collect();
                index += 2;
            }
            other => {
                eprintln!("无法识别的参数: {other}");
                usage();
                std::process::exit(2);
            }
        }
    }
    let policy = match policy {
        Some(p) => p,
        None => {
            eprintln!("--policy 为必填");
            usage();
            std::process::exit(2);
        }
    };
    (policy, upstream, cwd, log_file, del_to_trash, trash_dir, ro_dirs)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
        usage();
        return;
    }
    let sub = args[0].clone();
    let rest: Vec<String> = args[1..].to_vec();
    let result = match sub.as_str() {
        "detect" => run_detect(),
        "debug-rules" => run_debug_rules(&rest),
        "endpoint" => run_endpoint(&rest),
        "run" => {
            let cut = rest.iter().position(|a| a == "--");
            let (before, after) = match cut {
                Some(c) => (&rest[..c], &rest[c + 1..]),
                None => {
                    eprintln!("run 子命令需要 -- 之后的子进程命令行");
                    usage();
                    std::process::exit(2);
                }
            };
            let (policy_path, upstream, cwd, log_file, del_to_trash, trash_dir, ro_dirs) =
                parse_run_args(before);
            run_sandbox(
                &policy_path,
                upstream.as_deref(),
                cwd.as_deref(),
                log_file.as_deref(),
                del_to_trash,
                trash_dir.as_deref(),
                &ro_dirs,
                after,
            )
        }
        other => {
            eprintln!("未知子命令: {other}");
            usage();
            std::process::exit(2);
        }
    };
    match result {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("沙箱错误: {message}");
            std::process::exit(1);
        }
    }
}

fn run_endpoint(args: &[String]) -> Result<i32, String> {
    let mut port: u16 = 8080;
    let mut default = "deny";
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--port" if index + 1 < args.len() => {
                port = args[index + 1]
                    .parse()
                    .map_err(|_| format!("非法端口: {}", args[index + 1]))?;
                index += 2;
            }
            "--default" if index + 1 < args.len() => {
                default = &args[index + 1];
                index += 2;
            }
            other => {
                eprintln!("无法识别的参数: {other}");
                return Err("endpoint 用法: --port P [--default allow|deny]".to_string());
            }
        }
    }
    endpoint::run(port, default)
}

fn run_detect() -> Result<i32, String> {
    let report = serde_json::json!({
        "userns": sandbox::userns_available(),
        "fuse_device": sandbox::fuse_available(),
    });
    println!("{}", serde_json::to_string(&report).unwrap());
    Ok(0)
}

fn run_debug_rules(args: &[String]) -> Result<i32, String> {
    let mut policy_path = String::new();
    let mut path = "/".to_string();
    let mut access = "read".to_string();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--policy" if index + 1 < args.len() => {
                policy_path = args[index + 1].clone();
                index += 2;
            }
            "--path" if index + 1 < args.len() => {
                path = args[index + 1].clone();
                index += 2;
            }
            "--access" if index + 1 < args.len() => {
                access = args[index + 1].clone();
                index += 2;
            }
            other => {
                eprintln!("无法识别的参数: {other}");
                return Err("debug-rules 用法: --policy <rules.toml> [--path P] [--access read|write|execute]".to_string());
            }
        }
    }
    let policy = policy::Policy::load(&policy_path)?;
    policy.debug_rules();
    let access_bits = match access.as_str() {
        "read" => policy::ACC_READ,
        "write" => policy::ACC_WRITE,
        "execute" => policy::ACC_EXECUTE,
        "all" => policy::ACC_READ | policy::ACC_WRITE | policy::ACC_EXECUTE,
        other => {
            return Err(format!("--access 非法: {other}（read|write|execute|all）"));
        }
    };
    let decision = policy.check(&path, access_bits);
    println!("check({path}, {access}) -> {}", if decision { "allow" } else { "deny" });
    Ok(0)
}

fn load_policy(
    policy_path: &str,
    upstream: Option<&str>,
) -> Result<Arc<policy::Policy>, String> {
    let mut policy = policy::Policy::load(policy_path)?;
    if let Some(upstream) = upstream {
        policy.ask.endpoint = upstream.to_string();
    }
    Ok(Arc::new(policy))
}

fn run_sandbox(
    policy_path: &str,
    upstream: Option<&str>,
    cwd: Option<&str>,
    log_file: Option<&str>,
    del_to_trash: bool,
    trash_dir: Option<&str>,
    ro_dirs: &[String],
    child_argv: &[String],
) -> Result<i32, String> {
    if child_argv.is_empty() {
        return Err("run 需要 -- 之后的子进程命令行".to_string());
    }
    let policy = load_policy(policy_path, upstream)?;
    sandbox::run(sandbox::RunOptions {
        policy,
        child_argv: child_argv.to_vec(),
        cwd: cwd.map(|c| c.to_string()),
        ro_dirs: ro_dirs.to_vec(),
        log_file: log_file.map(|f| f.to_string()),
        del_to_trash,
        trash_dir: trash_dir.map(|d| d.to_string()),
    })
}