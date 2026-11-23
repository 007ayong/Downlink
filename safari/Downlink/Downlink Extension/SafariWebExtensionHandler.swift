//
//  SafariWebExtensionHandler.swift
//  Downlink Extension
//
//  Created by ayong on 2026/7/17.
//

import SafariServices
import os.log

private let localDNRBridgeURL = "http://127.0.0.1:17651/downlink-dnr/7f459ea1-29d8-4d22-90c3-9fbfd95071ac"

private final class LoopbackRequestPolicy: NSObject, URLSessionTaskDelegate {
    static func allows(_ url: URL, method: String) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return url.scheme?.lowercased() == "http"
            && ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host)
            && ["GET", "POST"].contains(method)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, Self.allows(url, method: request.httpMethod ?? "GET") else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private static let loopbackSession = URLSession(configuration: .default,
                                                    delegate: LoopbackRequestPolicy(),
                                                    delegateQueue: nil)

    private func complete(_ context: NSExtensionContext, reply: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: reply]
        } else {
            response.userInfo = ["message": reply]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@ (profile: %@)", String(describing: message), profile?.uuidString ?? "none")

        if let payload = message as? [String: Any], payload["type"] as? String == "HOST_SERVICE_STATUS" {
            var healthRequest = URLRequest(url: URL(string: localDNRBridgeURL + "/health")!)
            healthRequest.timeoutInterval = 1
            healthRequest.cachePolicy = .reloadIgnoringLocalCacheData
            Self.loopbackSession.dataTask(with: healthRequest) { data, response, _ in
                let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
                let connected = (response as? HTTPURLResponse)?.statusCode == 200
                    && body?["service"] as? String == "downlink"
                    && body?["protocol"] as? Int == 1
                self.complete(context, reply: ["connected": connected])
            }.resume()
            return
        }

        if let payload = message as? [String: Any], payload["type"] as? String == "START_DNR_BRIDGE" {
            // The containing macOS app owns the persistent loopback listener.
            // JavaScript probes this URL before it installs any DNR rule.
            complete(context, reply: ["ok": true, "bridgeUrl": localDNRBridgeURL])
            return
        }

        if let payload = message as? [String: Any], payload["type"] as? String == "LOCAL_HTTP_REQUEST" {
            let method = (payload["method"] as? String) ?? "GET"
            guard let urlText = payload["url"] as? String,
                  let url = URL(string: urlText),
                  LoopbackRequestPolicy.allows(url, method: method) else {
                complete(context, reply: ["error": "invalid-local-http-request"])
                return
            }
            var localRequest = URLRequest(url: url)
            localRequest.timeoutInterval = 5
            localRequest.httpMethod = method
            if let headers = payload["headers"] as? [String: String] {
                for (name, value) in headers { localRequest.setValue(value, forHTTPHeaderField: name) }
            }
            if let body = payload["body"] as? String, !body.isEmpty {
                localRequest.httpBody = body.data(using: .utf8)
            }
            Self.loopbackSession.dataTask(with: localRequest) { data, response, error in
                if let error = error {
                    self.complete(context, reply: ["error": error.localizedDescription])
                    return
                }
                guard let httpResponse = response as? HTTPURLResponse else {
                    self.complete(context, reply: ["error": "invalid-local-http-response"])
                    return
                }
                var responseHeaders: [String: String] = [:]
                for (name, value) in httpResponse.allHeaderFields {
                    responseHeaders[String(describing: name)] = String(describing: value)
                }
                self.complete(context, reply: [
                    "status": httpResponse.statusCode,
                    "headers": responseHeaders,
                    "body": data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                ])
            }.resume()
            return
        }

        complete(context, reply: ["echo": message as Any])
    }
}
