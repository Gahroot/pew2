import { describe, expect, test } from "bun:test";

// Build 18 was linked against the iOS 27 SDK with no scene life cycle and was
// killed by UIKit at launch. The plugin's AppDelegate edit is the half that can
// silently drift with Expo's template, so it is pinned here against SDK 54's.
const { patchAppDelegate } = (await import("../plugins/withSceneLifecycle.js")) as unknown as {
  patchAppDelegate: (source: string) => string;
};

const TEMPLATE = `public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    bindReactNativeFactory(factory)

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
`;

describe("withSceneLifecycle", () => {
  test("moves React Native start-up out of the app delegate and names the scene delegate", () => {
    const out = patchAppDelegate(TEMPLATE);
    expect(out).not.toContain("UIWindow(frame:");
    expect(out).not.toContain("startReactNative");
    expect(out).toContain("configurationForConnecting");
    expect(out).toContain("configuration.delegateClass = SceneDelegate.self");
  });

  test("is idempotent across prebuilds", () => {
    const once = patchAppDelegate(TEMPLATE);
    expect(patchAppDelegate(once)).toBe(once);
  });

  test("fails the prebuild when the template no longer matches", () => {
    expect(() => patchAppDelegate("public class AppDelegate: ExpoAppDelegate {}\n")).toThrow(
      /Expo template has changed/,
    );
  });
});
