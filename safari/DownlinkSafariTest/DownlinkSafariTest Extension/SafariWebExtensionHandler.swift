//
//  SafariWebExtensionHandler.swift
//  DownlinkSafariTest Extension
//
//  Created by ayong on 2026/7/17.
//

import SafariServices
import os.log

private let localDNRBridgeURL = "http://127.0.0.1:17651/downlink-dnr/7f459ea1-29d8-4d22-90c3-9fbfd95071ac"

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

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

        let reply: [String: Any]
        if let payload = message as? [String: Any], payload["type"] as? String == "START_DNR_BRIDGE" {
            // The containing macOS app owns the persistent loopback listener.
            // JavaScript probes this URL before it installs any DNR rule.
            reply = ["ok": true, "bridgeUrl": localDNRBridgeURL]
        } else {
            reply = ["echo": message as Any]
        }

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: reply]
        } else {
            response.userInfo = ["message": reply]
        }

        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
