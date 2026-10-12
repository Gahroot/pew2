import ExpoModulesCore
import AVFoundation
import MediaPlayer

/// The only code that touches AVAudioSession. Decisions live in
/// src/voice/audioPolicy.ts; this maps them onto the platform.
/// UNTESTED ON DEVICE (no iOS device was available when this was written).
public class Pew2VoiceModule: Module {
  private var observing = false
  private var remoteTargets: [Any] = []

  public func definition() -> ModuleDefinition {
    Name("Pew2Voice")

    Events("interruption", "routeChange", "remoteToggle")

    /// options: names from audioPolicy.ts `AudioOption`.
    AsyncFunction("activate") { (options: [String]) throws in
      let session = AVAudioSession.sharedInstance()
      var opts: AVAudioSession.CategoryOptions = []
      for name in options {
        switch name {
        case "allowBluetooth": opts.insert(.allowBluetooth)
        case "allowBluetoothA2DP": opts.insert(.allowBluetoothA2DP)
        case "defaultToSpeaker": opts.insert(.defaultToSpeaker)
        case "interruptSpokenAudioAndMixWithOthers": opts.insert(.interruptSpokenAudioAndMixWithOthers)
        default: break
        }
      }
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: opts)
      try session.setActive(true)
      self.startObserving()
      self.registerRemoteCommands()
    }

    /// Releases the session so Music/Podcasts resume.
    AsyncFunction("deactivate") { () throws in
      self.stopObserving()
      self.unregisterRemoteCommands()
      try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    Function("currentRoute") { () -> [String: String] in
      return Self.describeRoute(AVAudioSession.sharedInstance().currentRoute)
    }
  }

  private static func kind(_ port: AVAudioSession.Port?) -> String {
    switch port {
    case .builtInSpeaker: return "builtin_speaker"
    case .builtInReceiver: return "builtin_receiver"
    case .builtInMic: return "builtin_mic"
    case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE: return "bluetooth"
    case .headphones, .headsetMic, .usbAudio: return "wired"
    default: return "other"
    }
  }

  private static func describeRoute(_ route: AVAudioSessionRouteDescription) -> [String: String] {
    return [
      "output": kind(route.outputs.first?.portType),
      "input": kind(route.inputs.first?.portType),
    ]
  }

  private func startObserving() {
    guard !observing else { return }
    observing = true
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(onInterruption(_:)),
                       name: AVAudioSession.interruptionNotification, object: nil)
    center.addObserver(self, selector: #selector(onRouteChange(_:)),
                       name: AVAudioSession.routeChangeNotification, object: nil)
  }

  private func stopObserving() {
    guard observing else { return }
    observing = false
    NotificationCenter.default.removeObserver(self)
  }

  @objc private func onInterruption(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    if type == .began {
      sendEvent("interruption", ["phase": "began", "shouldResume": false])
    } else {
      let optRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      let should = AVAudioSession.InterruptionOptions(rawValue: optRaw).contains(.shouldResume)
      sendEvent("interruption", ["phase": "ended", "shouldResume": should])
    }
  }

  @objc private func onRouteChange(_ note: Notification) {
    let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
    let reason: String
    switch AVAudioSession.RouteChangeReason(rawValue: raw) {
    case .newDeviceAvailable: reason = "newDeviceAvailable"
    case .oldDeviceUnavailable: reason = "oldDeviceUnavailable"
    case .categoryChange: reason = "categoryChange"
    case .override: reason = "override"
    case .wakeFromSleep: reason = "wakeFromSleep"
    case .noSuitableRouteForCategory: reason = "noSuitableRouteForCategory"
    case .routeConfigurationChange: reason = "routeConfigurationChange"
    default: reason = "unknown"
    }
    var body = Self.describeRoute(AVAudioSession.sharedInstance().currentRoute)
    body["reason"] = reason
    if let prev = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription {
      let p = Self.describeRoute(prev)
      body["previousOutput"] = p["output"]
      body["previousInput"] = p["input"]
    }
    sendEvent("routeChange", body)
  }

  /// While a conversation is live, an AirPods stem press / headset button
  /// (play-pause) is delivered here instead of to the music app. We report it;
  /// JS ends the conversation. Not registered when idle: iOS offers no way to
  /// receive these without owning Now Playing.
  private func registerRemoteCommands() {
    guard remoteTargets.isEmpty else { return }
    let center = MPRemoteCommandCenter.shared()
    let handler: (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus = { [weak self] _ in
      self?.sendEvent("remoteToggle", [:])
      return .success
    }
    remoteTargets = [
      center.togglePlayPauseCommand.addTarget(handler: handler),
      center.pauseCommand.addTarget(handler: handler),
      center.playCommand.addTarget(handler: handler),
    ]
  }

  private func unregisterRemoteCommands() {
    let center = MPRemoteCommandCenter.shared()
    let commands = [center.togglePlayPauseCommand, center.pauseCommand, center.playCommand]
    for (command, target) in zip(commands, remoteTargets) { command.removeTarget(target) }
    remoteTargets = []
  }
}
