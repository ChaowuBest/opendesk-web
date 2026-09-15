/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

namespace Dynobox;

/// <summary>极简控制台日志（带时间戳与级别）。</summary>
public static class Log
{
    private static readonly object Gate = new();
    private static LogLevel _level = LogLevel.Info;
    // Manager diagnostics have their own sink; stdout/stderr belong to the child
    // when the host selects a log file. This handle is never inherited.
    private static TextWriter _writer = Console.Error;

    public static void SetFile(string path)
    {
        lock (Gate)
        {
            _writer = new StreamWriter(new FileStream(path, FileMode.Create, FileAccess.Write,
                FileShare.ReadWrite), new System.Text.UTF8Encoding(false)) { AutoFlush = true };
        }
    }

    public static void Close()
    {
        lock (Gate)
        {
            if (!ReferenceEquals(_writer, Console.Error)) _writer.Dispose();
            _writer = Console.Error;
        }
    }

    public static bool Verbose
    {
        set => _level = value ? LogLevel.Debug : LogLevel.Info;
    }

    private enum LogLevel { Debug = 0, Info = 1, Warn = 2, Error = 3 }

    public static void Debug(string fmt, params object?[] args)
    {
        if (_level <= LogLevel.Debug) Write("DBG ", fmt, args);
    }

    public static void Info(string fmt, params object?[] args) => Write("INFO", fmt, args);

    public static void Warn(string fmt, params object?[] args) => Write("WARN", fmt, args);

    public static void Error(string fmt, params object?[] args) => Write("ERR ", fmt, args);

    private static void Write(string tag, string fmt, object?[] args)
    {
        lock (Gate)
        {
            _writer.Write($"{DateTime.Now:HH:mm:ss.fff} {tag} ");
            _writer.WriteLine(args.Length == 0 ? fmt : string.Format(fmt, args));
        }
    }
}
