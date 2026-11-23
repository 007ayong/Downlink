//
//  ViewController.swift
//  Downlink
//
//  Created by ayong on 2026/7/17.
//

import Cocoa
import SafariServices
import ServiceManagement
import WebKit

let extensionBundleIdentifier = "cc.winapps.downlink.extension"

class ViewController: NSViewController, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    private var safariStatusQueryInFlight = false
    private var lastSafariExtensionEnabled: Bool?

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        NotificationCenter.default.addObserver(self, selector: #selector(refreshDashboard),
            name: NSApplication.didBecomeActiveNotification, object: nil)
        self.webView.navigationDelegate = self

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.delegate = self
    }

    private func hideSetupWindow() {
        view.window?.orderOut(nil)
        _ = NSApp.setActivationPolicy(.accessory)
    }

    // The red close button hides only the setup UI. Returning false prevents
    // AppKit from closing the host window and ending the bridge lifecycle.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hideSetupWindow()
        return false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        refreshDashboard()
    }

    @objc private func refreshDashboard() {
        guard isViewLoaded else { return }
        refreshLoginItemState()
        guard !safariStatusQueryInFlight else { return }
        safariStatusQueryInFlight = true
        querySafariExtensionStatus(retriesRemaining: 2)
    }

    private func querySafariExtensionStatus(retriesRemaining: Int) {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { [weak self] state, error in
            let enabled = error == nil ? state?.isEnabled : nil
            DispatchQueue.main.async {
                guard let self = self else { return }
                if enabled == nil, retriesRemaining > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                        self?.querySafariExtensionStatus(retriesRemaining: retriesRemaining - 1)
                    }
                    return
                }

                self.safariStatusQueryInFlight = false
                if let enabled = enabled { self.lastSafariExtensionEnabled = enabled }
                let value = self.lastSafariExtensionEnabled.map { $0 ? "true" : "false" } ?? "null"
                self.webView.evaluateJavaScript("show(\(value), \(enabled == nil))")
            }
        }
    }

    @objc private func refreshLoginItemState() {
        guard isViewLoaded,
              let data = try? JSONSerialization.data(withJSONObject: LoginItemController.state().merging(["error": LoginItemController.registrationError ?? ""], uniquingKeysWith: { current, _ in current })),
              let json = String(data: data, encoding: .utf8) else { return }
        self.webView.evaluateJavaScript("showLoginItem(\(json))", completionHandler: nil)
        if let app = NSApp.delegate as? AppDelegate,
           let serviceData = try? JSONSerialization.data(withJSONObject: ["running": app.serviceRunning, "error": app.serviceError ?? ""]),
           let serviceJSON = String(data: serviceData, encoding: .utf8) {
            self.webView.evaluateJavaScript("showService(\(serviceJSON))", completionHandler: nil)
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let command = message.body as? String else { return }
        if command == "quit-downlink" {
            NSApp.terminate(self)
            return
        }
        if command == "toggle-service", let app = NSApp.delegate as? AppDelegate {
            if app.serviceRunning {
                let alert = NSAlert()
                alert.messageText = "停止后台服务？"
                alert.informativeText = "Safari 下载接管可能不可用。你可以随时在此重新启动服务；登录时启动设置不会改变。"
                alert.addButton(withTitle: "停止服务")
                alert.addButton(withTitle: "取消")
                if alert.runModal() == .alertFirstButtonReturn { app.stopService() }
            } else { app.startService() }
            refreshDashboard()
            return
        }
        if command == "refresh" { refreshDashboard(); return }
        if command == "login-settings" {
            if #available(macOS 13.0, *) { SMAppService.openSystemSettingsLoginItems() }
            return
        }
        if command == "login-enable" || command == "login-disable" {
            if #available(macOS 13.0, *) {
                let action = LoginItemController.state()["action"]
                if command == "login-enable", action == "register" {
                    LoginItemController.setEnabled(true)
                } else if command == "login-disable", action == "unregister" {
                    LoginItemController.setEnabled(false)
                }
            }
            refreshLoginItemState()
            return
        }
        guard command == "open-preferences" else { return }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { [weak self] error in
            DispatchQueue.main.async {
                if let error = error {
                    let alert = NSAlert()
                    alert.messageText = "无法打开 Safari 设置"
                    alert.informativeText = error.localizedDescription
                    alert.runModal()
                }
                self?.refreshDashboard()
            }
        }
    }

}
