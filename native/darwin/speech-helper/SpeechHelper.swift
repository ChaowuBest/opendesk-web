/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import AVFoundation
import Foundation
import Speech

let outputLock = NSLock()

func writeJSON(_ payload: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(payload),
        let data = try? JSONSerialization.data(withJSONObject: payload, options: [])
    else {
        return
    }

    outputLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
    fflush(stdout)
    outputLock.unlock()
}

func writeError(_ message: String) {
    guard let data = (message + "\n").data(using: .utf8) else {
        return
    }
    FileHandle.standardError.write(data)
}

func normalizedLocaleIdentifier(_ identifier: String) -> String {
    return identifier.replacingOccurrences(of: "_", with: "-").lowercased()
}

func localeLanguageCode(_ locale: Locale) -> String? {
    return Locale.components(fromIdentifier: locale.identifier)[NSLocale.Key.languageCode.rawValue]
}

func localeRegionCode(_ locale: Locale) -> String? {
    return Locale.components(fromIdentifier: locale.identifier)[NSLocale.Key.countryCode.rawValue]
}

@available(macOS 10.15, *)
func resolveSpeechLocale(_ preferredIdentifier: String? = nil) -> Locale {
    let supportedLocales = SFSpeechRecognizer.supportedLocales()
    var candidates: [String] = []

    if let override = ProcessInfo.processInfo.environment["OPENDESK_SPEECH_LOCALE"]?.trimmingCharacters(in: .whitespacesAndNewlines),
        !override.isEmpty
    {
        candidates.append(override)
    }
    if let preferred = preferredIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines),
        !preferred.isEmpty,
        preferred != "auto"
    {
        candidates.append(preferred)
    }
    candidates.append(contentsOf: Locale.preferredLanguages)
    candidates.append(Locale.current.identifier)

    for candidate in candidates {
        let normalizedCandidate = normalizedLocaleIdentifier(candidate)
        if let match = supportedLocales.first(where: {
            normalizedLocaleIdentifier($0.identifier) == normalizedCandidate
        }) {
            return match
        }
    }

    for candidate in candidates {
        let locale = Locale(identifier: candidate)
        guard let languageCode = localeLanguageCode(locale) else {
            continue
        }
        let regionCode = localeRegionCode(locale)
        if let match = supportedLocales.first(where: {
            localeLanguageCode($0) == languageCode && (regionCode == nil || localeRegionCode($0) == regionCode)
        }) {
            return match
        }
        if let match = supportedLocales.first(where: { localeLanguageCode($0) == languageCode }) {
            return match
        }
    }

    return Locale.current
}

@available(macOS 10.15, *)
func makeSpeechRecognizer(_ preferredIdentifier: String? = nil) -> SFSpeechRecognizer? {
    let locale = resolveSpeechLocale(preferredIdentifier)
    return SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(locale: Locale.current)
}

func prefersOnDeviceRecognition() -> Bool {
    guard let value = ProcessInfo.processInfo.environment["OPENDESK_SPEECH_REQUIRES_ON_DEVICE"]?
        .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    else {
        return false
    }
    return ["1", "true", "yes", "on"].contains(value)
}

func available() -> Bool {
    if #available(macOS 10.15, *) {
        guard let recognizer = makeSpeechRecognizer() else {
            return false
        }
        return recognizer.isAvailable
    }
    return false
}

if CommandLine.arguments.contains("--check") {
    writeJSON(["available": available()])
    exit(0)
}

@available(macOS 10.15, *)
final class SpeechDaemon {
    private var recognizerLocale: Locale
    private var recognizer: SFSpeechRecognizer?
    private var audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var initialized = false
    private var recording = false
    private var content = ""
    private var finished = false
    private var pendingStopId: Int?
    private var pendingStopContent = ""
    private var stopFallbackWorkItem: DispatchWorkItem?

    init() {
        recognizerLocale = resolveSpeechLocale()
        recognizer = SFSpeechRecognizer(locale: recognizerLocale)
        writeError("[darwin-speech] using locale: \(recognizerLocale.identifier)")
    }

    func handle(_ command: [String: Any]) {
        let id = command["id"] as? Int ?? 0
        guard let method = command["method"] as? String else {
            respondError(id, "Missing command method")
            return
        }

        switch method {
        case "available":
            respond(id, available())
        case "initialize":
            initialize(id, command["locale"] as? String)
        case "start":
            start(id)
        case "peek":
            respond(id, ["content": content, "finished": finished])
        case "stop":
            stop(id)
        case "release":
            release(id)
        default:
            respondError(id, "Unsupported method: \(method)")
        }
    }

    private func respond(_ id: Int, _ data: Any?) {
        writeJSON(["id": id, "ok": true, "data": data ?? NSNull()])
    }

    private func respondError(_ id: Int, _ message: String) {
        writeJSON(["id": id, "ok": false, "message": message])
    }

    private func initialize(_ id: Int, _ localeIdentifier: String?) {
        if recording {
            respondError(id, "Speech recognition is already recording")
            return
        }
        guard applySpeechLocale(localeIdentifier), recognizer?.isAvailable == true else {
            respondError(id, "macOS speech recognition is not available")
            return
        }

        if initialized {
            respond(id, NSNull())
            return
        }

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard let self = self else {
                return
            }
            guard status == .authorized else {
                DispatchQueue.main.async {
                    self.respondError(id, "Speech recognition permission was not granted")
                }
                return
            }

            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async {
                    guard granted else {
                        self.respondError(id, "Microphone permission was not granted")
                        return
                    }
                    self.initialized = true
                    self.respond(id, NSNull())
                }
            }
        }
    }

    private func applySpeechLocale(_ localeIdentifier: String?) -> Bool {
        let locale = resolveSpeechLocale(localeIdentifier)
        if normalizedLocaleIdentifier(locale.identifier) == normalizedLocaleIdentifier(recognizerLocale.identifier),
            recognizer != nil
        {
            return true
        }

        guard let nextRecognizer = SFSpeechRecognizer(locale: locale) else {
            return false
        }
        recognizerLocale = locale
        recognizer = nextRecognizer
        writeError("[darwin-speech] using locale: \(recognizerLocale.identifier)")
        return true
    }

    private func start(_ id: Int) {
        guard initialized else {
            respondError(id, "Speech recognizer has not been initialized")
            return
        }
        guard let recognizer = recognizer else {
            respondError(id, "macOS speech recognizer could not be created")
            return
        }
        guard !recording else {
            respondError(id, "Speech recognition is already recording")
            return
        }

        stopCapture(endAudio: false)
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        audioEngine = AVAudioEngine()
        content = ""
        finished = false

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if prefersOnDeviceRecognition() && recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        recognitionRequest = request

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self = self else {
                    return
                }
                if let result {
                    self.content = result.bestTranscription.formattedString
                    self.finished = result.isFinal
                }
                if error != nil {
                    writeError("[darwin-speech] recognition error: \(String(describing: error))")
                    self.finished = true
                }
                if self.finished {
                    self.stopCapture(endAudio: false)
                    self.finishPendingStop()
                }
            }
        }

        let inputNode = audioEngine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak request] buffer, _ in
            request?.append(buffer)
        }
        tapInstalled = true

        do {
            audioEngine.prepare()
            try audioEngine.start()
            recording = true
            respond(id, NSNull())
        } catch {
            stopCapture(endAudio: false)
            recognitionTask?.cancel()
            recognitionTask = nil
            recognitionRequest = nil
            respondError(id, "Failed to start audio engine: \(error.localizedDescription)")
        }
    }

    private func stop(_ id: Int) {
        if pendingStopId != nil {
            respond(id, content)
            return
        }

        pendingStopId = id
        pendingStopContent = content
        stopCapture(endAudio: true)
        finished = true

        let fallback = DispatchWorkItem { [weak self] in
            guard let self = self else {
                return
            }
            self.finishPendingStop()
        }
        stopFallbackWorkItem = fallback
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: fallback)
    }

    private func release(_ id: Int) {
        stopCapture(endAudio: false)
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        initialized = false
        content = ""
        finished = false
        finishPendingStop()
        respond(id, NSNull())
    }

    private func stopCapture(endAudio: Bool) {
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        if endAudio {
            recognitionRequest?.endAudio()
        }
        recording = false
    }

    private func finishPendingStop() {
        guard let id = pendingStopId else {
            return
        }

        stopFallbackWorkItem?.cancel()
        stopFallbackWorkItem = nil
        pendingStopId = nil

        let finalContent = content.isEmpty ? pendingStopContent : content
        pendingStopContent = ""
        recognitionTask = nil
        recognitionRequest = nil
        respond(id, finalContent)
    }
}

if #available(macOS 10.15, *) {
    let daemon = SpeechDaemon()

    DispatchQueue.global(qos: .userInitiated).async {
        while let line = readLine() {
            guard let data = line.data(using: .utf8),
                let command = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
            else {
                writeJSON(["id": 0, "ok": false, "message": "Invalid JSON command"])
                continue
            }

            DispatchQueue.main.async {
                daemon.handle(command)
            }
        }

        DispatchQueue.main.async {
            exit(0)
        }
    }

    RunLoop.main.run()
} else {
    writeJSON(["id": 0, "ok": false, "message": "macOS speech recognition requires macOS 10.15 or newer"])
    exit(1)
}
