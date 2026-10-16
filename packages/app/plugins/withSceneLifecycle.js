/**
 * Adopts the UIScene life cycle, which the iOS 27 SDK makes mandatory.
 *
 * Built with Xcode 27, an app whose Info.plist has no scene manifest is killed by
 * UIKit as its first scene connects: EXC_BREAKPOINT in
 * `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`, before any JS
 * runs. Build 18 shipped exactly that. The check follows the SDK the app is
 * *linked* against, not the phone's iOS, so builds made with Xcode 26 still
 * launch. That is also why the image pin in eas.json did not help:
 * `eas build --local` uses whatever Xcode this Mac has selected.
 *
 * Expo SDK 54's template still creates its window in the app delegate, and
 * ExpoAppDelegate has no scene delegate of its own (SDK 57 adds one). This
 * plugin therefore does three things:
 *   1. declares a single-scene UIApplicationSceneManifest;
 *   2. writes SceneDelegate.swift. It creates the window on the scene and starts
 *      React Native there, with the scene's URL or user activity passed as
 *      launchOptions. RCTLinkingManager's getInitialURL reads only launchOptions,
 *      so a cold start from pew2://voice would otherwise arrive as nothing. Warm
 *      links and life-cycle callbacks are handed to the app delegate, because
 *      under scenes UIKit stops calling those on it, and ExpoAppDelegate fans
 *      them out to every module's subscriber;
 *   3. edits AppDelegate.swift so it stops starting React Native itself and
 *      answers `configurationForConnecting`.
 * Every template edit must match exactly once, so an Expo upgrade that moves the
 * template fails the prebuild instead of silently shipping a half-adopted app.
 * Delete this once the Expo template adopts scenes.
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  withAppDelegate,
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
  IOSConfig,
} = require("expo/config-plugins");

const FILE = "SceneDelegate.swift";
const MARKER = "// pew2: scene life cycle";

const SWIFT = `import Expo
import React
import UIKit

${MARKER} (plugins/withSceneLifecycle.js)
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var appDelegate: AppDelegate? {
    UIApplication.shared.delegate as? AppDelegate
  }

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = appDelegate,
          let factory = appDelegate.reactNativeFactory else { return }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    // Under scenes a launch URL or activity arrives here rather than in the app
    // delegate's launchOptions, which is all RCTLinkingManager.getInitialURL reads.
    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[.url] = url
    }
    if let activity = connectionOptions.userActivities.first {
      launchOptions[.userActivityDictionary] = [
        UIApplication.LaunchOptionsKey.userActivityType: activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity,
      ]
    }

    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = appDelegate else { return }
    for context in URLContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
      if let source = context.options.sourceApplication {
        options[.sourceApplication] = source
      }
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = appDelegate?.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate?.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate?.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate?.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate?.applicationDidEnterBackground(UIApplication.shared)
  }
}
`;

const START_BLOCK = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
`;

const START_REPLACEMENT = `    ${MARKER}: React Native starts in SceneDelegate, on the scene's window.
`;

const LINKING_ANCHOR = "  // Linking API\n";

const CONFIGURATION = `  ${MARKER}: one window scene, driven by SceneDelegate.
  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }

`;

function replaceOnce(source, find, replacement, what) {
  const first = source.indexOf(find);
  if (first === -1 || source.indexOf(find, first + find.length) !== -1) {
    throw new Error(
      `withSceneLifecycle: expected exactly one ${what} in AppDelegate.swift; the Expo template has changed, so update this plugin.`,
    );
  }
  return source.slice(0, first) + replacement + source.slice(first + find.length);
}

function patchAppDelegate(contents) {
  if (contents.includes(MARKER)) return contents;
  let out = replaceOnce(contents, START_BLOCK, START_REPLACEMENT, "window/startReactNative block");
  out = replaceOnce(out, LINKING_ANCHOR, CONFIGURATION + LINKING_ANCHOR, "'// Linking API' anchor");
  return out;
}

function withSceneLifecycle(config) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };
    return cfg;
  });

  config = withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== "swift") {
      throw new Error("withSceneLifecycle: expected a Swift AppDelegate.");
    }
    cfg.modResults.contents = patchAppDelegate(cfg.modResults.contents);
    return cfg;
  });

  config = withDangerousMod(config, [
    "ios",
    (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, cfg.modRequest.projectName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, FILE), SWIFT);
      return cfg;
    },
  ]);

  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const name = cfg.modRequest.projectName;
    const filepath = `${name}/${FILE}`;
    if (!project.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath,
        groupName: name,
        project,
        isBuildFile: true,
      });
    }
    return cfg;
  });
}

module.exports = withSceneLifecycle;
module.exports.patchAppDelegate = patchAppDelegate;
