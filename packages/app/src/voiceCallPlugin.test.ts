import { describe, expect, test } from "bun:test";

// The AppDelegate edit is the half of the native call screen that can drift
// silently with Expo's template, and a VoIP push the app fails to report gets
// it killed by iOS. Pinned against SDK 54's template.
const plugin = (await import("../plugins/withVoiceCall.js")) as unknown as {
  patchAppDelegate: (source: string) => string;
  patchBridgingHeader: (source: string) => string;
};

const TEMPLATE = `import Expo
import React

public class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    bindReactNativeFactory(factory)

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

describe("withVoiceCall", () => {
  test("registers PushKit before launch returns and reports every VoIP push to CallKit", () => {
    const out = plugin.patchAppDelegate(TEMPLATE);
    expect(out).toContain("import PushKit");
    expect(out.indexOf("voipRegistration()")).toBeLessThan(
      out.indexOf("return super.application(application, didFinishLaunchingWithOptions"),
    );
    expect(out).toContain("extension AppDelegate: PKPushRegistryDelegate");
    expect(out).toContain("RNCallKeep.reportNewIncomingCall(");
    expect(out).toContain('fields["caller"]');
  });

  test("is idempotent, so a second prebuild does not add a second delegate", () => {
    const once = plugin.patchAppDelegate(TEMPLATE);
    expect(plugin.patchAppDelegate(once)).toBe(once);
    const header = plugin.patchBridgingHeader("#import <Foo.h>\n");
    expect(plugin.patchBridgingHeader(header)).toBe(header);
  });

  test("fails the build loudly when the template moved, never silently without ringing", () => {
    expect(() => plugin.patchAppDelegate("import Expo\nclass AppDelegate {}\n")).toThrow(
      /launch anchor/,
    );
  });
});
