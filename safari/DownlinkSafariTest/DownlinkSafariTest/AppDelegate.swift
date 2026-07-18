//
//  AppDelegate.swift
//  DownlinkSafariTest
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

    func start() throws {
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
        source.setCancelHandler { Darwin.close(socketFD) }
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
        let body = "<!doctype html><meta charset=utf-8><title>Downlink</title>"
        let response = validRequest
            ? "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
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

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    private var launchedAsLoginItem = false

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

        registerAsLoginItemIfNeeded()

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
        } catch {
            os_log(.error, "Unable to start persistent local DNR bridge: %@", error.localizedDescription)
        }
    }

    private func registerAsLoginItemIfNeeded() {
        // Allows an unsigned development build to run beside an installed copy
        // with the same bundle identifier without Launch Services replacing it.
        if ProcessInfo.processInfo.environment["DOWNLINK_SKIP_LOGIN_ITEM"] == "1" {
            return
        }

        if #available(macOS 13.0, *) {
            do {
                if SMAppService.mainApp.status == .notRegistered {
                    try SMAppService.mainApp.register()
                }
            } catch {
                os_log(.error, "Unable to register Downlink as a login item: %@", error.localizedDescription)
            }
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
