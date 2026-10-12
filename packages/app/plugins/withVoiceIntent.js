/**
 * Adds the "Talk to PEW2" App Intent to the app target.
 *
 * Why a plugin and not the local module: App Shortcuts are discovered from the
 * app's own binary; an intent inside a CocoaPods static library is not reliably
 * picked up by the metadata extractor. The Swift file is written into the app
 * target's group and added to its Compile Sources phase.
 *
 * The intent does one thing: open pew2://voice?source=siri_shortcut. It cannot
 * start the microphone itself (iOS does not allow that from an intent), so the
 * app opens and `useVoice` starts the conversation from the link.
 *
 * UNTESTED ON DEVICE. Needs iOS 16+ (shortcuts phrases: 16.4+).
 */
const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withXcodeProject, IOSConfig } = require("expo/config-plugins");

const FILE = "Pew2VoiceIntents.swift";

const SWIFT = `import AppIntents
import UIKit

@available(iOS 16.0, *)
struct TalkToPew2Intent: AppIntent {
  static var title: LocalizedStringResource = "Talk to PEW2"
  static var description = IntentDescription("Start a hands-free voice conversation with your coding agents.")
  static var openAppWhenRun: Bool = true

  @MainActor
  func perform() async throws -> some IntentResult {
    if let url = URL(string: "pew2://voice?source=siri_shortcut") {
      await UIApplication.shared.open(url)
    }
    return .result()
  }
}

@available(iOS 16.4, *)
struct Pew2Shortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: TalkToPew2Intent(),
      phrases: [
        "Talk to \\(.applicationName)",
        "Open \\(.applicationName) voice",
        "Hey \\(.applicationName)",
      ],
      shortTitle: "Talk to PEW2",
      systemImageName: "waveform"
    )
  }
}
`;

function withVoiceIntent(config) {
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

module.exports = withVoiceIntent;
