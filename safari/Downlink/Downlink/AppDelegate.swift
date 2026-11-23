//
//  AppDelegate.swift
//  Downlink
//
//  Created by ayong on 2026/7/17.
//

import Cocoa
import Carbon
import Darwin
import ServiceManagement
import os.log

private final class PersistentLocalDNRBridge {
    static let shared = PersistentLocalDNRBridge()
    static let port: UInt16 = 17651
    static let token = "7f459ea1-29d8-4d22-90c3-9fbfd95071ac"

    private let queue = DispatchQueue(label: "cc.winapps.downlink.host-dnr-bridge")
    private var serverSocket: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private var listenerClosed: DispatchSemaphore?

    var isRunning: Bool { queue.sync { serverSocket >= 0 } }

    func stop() {
        let closed = queue.sync { () -> DispatchSemaphore? in
            guard let source = acceptSource else { return nil }
            let closed = listenerClosed
            source.cancel()
            acceptSource = nil
            listenerClosed = nil
            serverSocket = -1
            return closed
        }
        // Wait outside the listener queue so the cancellation handler can run.
        closed?.wait()
    }

    func start() throws {
        try queue.sync { try startListener() }
    }

    private func startListener() throws {
        if serverSocket >= 0 { return }

        let socketFD = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socketFD >= 0 else { throw bridgeError("socket", errno) }

        var reuseAddress: Int32 = 1
        guard setsockopt(socketFD, SOL_SOCKET, SO_REUSEADDR, &reuseAddress, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            let code = errno
            Darwin.close(socketFD)
            throw bridgeError("setsockopt", code)
        }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(Self.port).bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                Darwin.bind(socketFD, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            let code = errno
            Darwin.close(socketFD)
            throw bridgeError("bind", code)
        }
        guard Darwin.listen(socketFD, 8) == 0 else {
            let code = errno
            Darwin.close(socketFD)
            throw bridgeError("listen", code)
        }

        let currentFlags = fcntl(socketFD, F_GETFL, 0)
        if currentFlags >= 0 {
            _ = fcntl(socketFD, F_SETFL, currentFlags | O_NONBLOCK)
        }

        serverSocket = socketFD
        let source = DispatchSource.makeReadSource(fileDescriptor: socketFD, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptPendingConnections() }
        let closed = DispatchSemaphore(value: 0)
        source.setCancelHandler {
            Darwin.close(socketFD)
            closed.signal()
        }
        listenerClosed = closed
        acceptSource = source
        source.resume()
        os_log(.default, "Persistent local DNR bridge listening on 127.0.0.1:%d", Self.port)
    }

    private func acceptPendingConnections() {
        while true {
            var clientAddress = sockaddr_in()
            var clientLength = socklen_t(MemoryLayout<sockaddr_in>.size)
            let clientSocket = withUnsafeMutablePointer(to: &clientAddress) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                    Darwin.accept(serverSocket, socketAddress, &clientLength)
                }
            }
            if clientSocket < 0 { return }
            handle(clientSocket)
        }
    }

    private func handle(_ clientSocket: Int32) {
        var noSigPipe: Int32 = 1
        _ = setsockopt(clientSocket, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        let currentFlags = fcntl(clientSocket, F_GETFL, 0)
        if currentFlags >= 0 {
            _ = fcntl(clientSocket, F_SETFL, currentFlags & ~O_NONBLOCK)
        }
        var timeout = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(clientSocket, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var requestBytes: [UInt8] = []
        requestBytes.reserveCapacity(1024)
        while requestBytes.count < 8192 && !requestBytes.contains(0x0A) {
            var buffer = [UInt8](repeating: 0, count: min(1024, 8192 - requestBytes.count))
            let received = buffer.withUnsafeMutableBytes { bytes in
                guard let baseAddress = bytes.baseAddress else { return -1 }
                return Darwin.recv(clientSocket, baseAddress, bytes.count, 0)
            }
            if received > 0 {
                requestBytes.append(contentsOf: buffer.prefix(Int(received)))
                continue
            }
            if received < 0 && errno == EINTR { continue }
            break
        }
        let request = String(decoding: requestBytes, as: UTF8.self)
        let expectedPath = "/downlink-dnr/\(Self.token)/"
        let validRequest = request.hasPrefix("GET \(expectedPath) ") ||
            request.hasPrefix("GET \(expectedPath)?") ||
            request.hasPrefix("HEAD \(expectedPath) ") ||
            request.hasPrefix("HEAD \(expectedPath)?")
        let isHealth = request.hasPrefix("GET \(expectedPath)health ")
        let healthy = validRequest || isHealth
        let body = isHealth ? "{\"service\":\"downlink\",\"protocol\":1}" : "<!doctype html><meta charset=utf-8><title>Downlink</title>"
        let contentType = isHealth ? "application/json" : "text/html; charset=utf-8"
        let response = healthy
            ? "HTTP/1.1 200 OK\r\nContent-Type: \(contentType)\r\nContent-Security-Policy: default-src 'none'; img-src safari-web-extension:\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
            : "HTTP/1.1 404 Not Found\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
        sendAll(Data(response.utf8), to: clientSocket)
        Darwin.shutdown(clientSocket, SHUT_RDWR)
        Darwin.close(clientSocket)
    }

    private func sendAll(_ data: Data, to socketFD: Int32) {
        data.withUnsafeBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return }
            var sentBytes = 0
            while sentBytes < bytes.count {
                let sent = Darwin.send(socketFD, baseAddress.advanced(by: sentBytes), bytes.count - sentBytes, 0)
                if sent > 0 {
                    sentBytes += sent
                    continue
                }
                if sent < 0 && errno == EINTR { continue }
                return
            }
        }
    }

    private func bridgeError(_ operation: String, _ code: Int32) -> NSError {
        NSError(
            domain: "cc.winapps.downlink.host-dnr-bridge",
            code: Int(code),
            userInfo: [NSLocalizedDescriptionKey: "Local DNR bridge \(operation) failed (errno \(code))"]
        )
    }
}

// Share the actual registration result with the setup window.
enum LoginItemController {
    static var registrationError: String?
    static var isInstalled: Bool {
        let path = Bundle.main.bundleURL.resolvingSymlinksInPath().path
        return path == "/Applications/Downlink.app" ||
            path == FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Applications/Downlink.app").path
    }

    static func setEnabled(_ enabled: Bool) {
        guard ProcessInfo.processInfo.environment["DOWNLINK_SKIP_LOGIN_ITEM"] != "1",
              isInstalled else { return }
        if #available(macOS 13.0, *) {
            registrationError = nil
            do {
                if enabled {
                    try SMAppService.mainApp.register()
                } else {
                    try SMAppService.mainApp.unregister()
                }
            } catch {
                registrationError = error.localizedDescription
                os_log(.error, "Unable to change Downlink login item: %@", error.localizedDescription)
            }
        }
    }

    static func state() -> [String: String] {
        guard isInstalled else {
            return ["message": "请先将 Downlink 安装到「应用程序」，再启用登录时启动。", "action": "none"]
        }
        if #available(macOS 13.0, *) {
            switch SMAppService.mainApp.status {
            case .enabled:
                return ["message": "已启用登录时启动：登录 Mac 后后台服务会自动运行。", "action": "unregister"]
            case .requiresApproval:
                return ["message": "自启动尚未获准。请在系统设置的「登录项」中允许 Downlink。", "action": "unregister", "settings": "true"]
            case .notRegistered:
                return ["message": registrationError.map { "自启动注册失败：" + $0 } ?? "尚未启用登录时启动。", "action": "register"]
            case .notFound:
                return ["message": registrationError.map { "自启动注册失败：" + $0 } ?? "系统尚未找到登录项，请点击下方按钮注册。", "action": "register"]
            @unknown default:
                return ["message": "无法确认自启动状态，请检查系统登录项设置。", "action": "settings"]
            }
        }
        return ["message": "此系统版本请在系统设置中手动将 Downlink 加入登录项。", "action": "none"]
    }
}

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    private var launchedAsLoginItem = false
    private(set) var serviceError: String?
    var serviceRunning: Bool { PersistentLocalDNRBridge.shared.isRunning }

    func stopService() {
        PersistentLocalDNRBridge.shared.stop()
        serviceError = nil
    }

    func startService() { startLocalBridge() }

    override init() {
        super.init()
        startLocalBridge()
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        launchedAsLoginItem = NSAppleEventManager.shared().currentAppleEvent?
            .paramDescriptor(forKeyword: AEKeyword(keyAELaunchedAsLogInItem)) != nil
        if launchedAsLoginItem {
            _ = NSApp.setActivationPolicy(.accessory)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // `init` starts the listener before Safari can ask the extension for the
        // bridge URL. Keep this idempotent call as a lifecycle safety net.
        startLocalBridge()

        if launchedAsLoginItem {
            // A login item provides the loopback bridge only; it must not show
            // the Safari extension setup window on every system login.
            DispatchQueue.main.async {
                NSApp.windows.forEach { $0.orderOut(nil) }
            }
        }
    }

    private func startLocalBridge() {
        do {
            try PersistentLocalDNRBridge.shared.start()
            serviceError = nil
        } catch {
            serviceError = error.localizedDescription
            os_log(.error, "Unable to start persistent local DNR bridge: %@", error.localizedDescription)
        }
    }

    // Closing the setup window must not stop the loopback bridge. Explicitly
    // choosing Quit Downlink still terminates the app and listener.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    // Reopening the already-running host from Finder brings the setup window
    // back. While the window is hidden the app stays as an accessory process,
    // so the loopback bridge does not require a visible window or Dock icon.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard !flag else { return true }

        _ = sender.setActivationPolicy(.regular)
        sender.windows.first?.makeKeyAndOrderFront(nil)
        sender.activate(ignoringOtherApps: true)
        return true
    }
}
