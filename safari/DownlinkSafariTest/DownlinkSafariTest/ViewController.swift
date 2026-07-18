//
//  ViewController.swift
//  DownlinkSafariTest
//
//  Created by ayong on 2026/7/17.
//

import Cocoa
import SafariServices
import WebKit

let extensionBundleIdentifier = "cc.winapps.downlink.DownlinkSafariTest.Extension"

class ViewController: NSViewController, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

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
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show(\(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show(\(state.isEnabled), false)")
                }
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if (message.body as! String != "open-preferences") {
            return;
        }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { [weak self] error in
            DispatchQueue.main.async {
                // The containing app owns the persistent loopback bridge.
                // Hide the setup window after opening Safari settings, but keep
                // the app and its 127.0.0.1 listener alive in the background.
                self?.hideSetupWindow()
            }
        }
    }

}
