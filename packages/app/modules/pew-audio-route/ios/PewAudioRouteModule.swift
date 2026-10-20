import AVFoundation
import ExpoModulesCore
import UIKit

/// The call's speaker button. The audio session itself belongs to WebRTC and
/// expo-audio; this only overrides the *output port* for the live session, which
/// neither of them exposes. Overriding to `.none` hands routing back to iOS:
/// the receiver, or AirPods / a headset when one is connected.
public class PewAudioRouteModule: Module {
  /// Cue players kept alive while they play (an AVAudioPlayer released mid-sound stops).
  private var cues: [String: AVAudioPlayer] = [:]
  private let cueQueue = DispatchQueue(label: "pew2.audio-cues")
  /// The speaker the user chose for this call. iOS drops an output override
  /// whenever the session is reconfigured (WebRTC starting its audio, CallKit
  /// activating, a category change), which is why the button flipped back by
  /// itself: the choice is kept here and put back after each such change.
  private var wantSpeaker = false
  private var routeObserver: NSObjectProtocol?
  private var interruptionObserver: NSObjectProtocol?

  /// A phone call, Siri or an alarm took the audio and gave it back: make the
  /// session active again and put the speaker choice back, or the call stays
  /// silent after it. (A call answered through CallKit gets this from
  /// CallKit itself.)
  private func interrupted(_ note: Notification) {
    guard
      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      AVAudioSession.InterruptionType(rawValue: raw) == .ended
    else { return }
    let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map(AVAudioSession.InterruptionOptions.init) ?? []
    guard options.contains(.shouldResume) else { return }
    let session = AVAudioSession.sharedInstance()
    try? session.setActive(true)
    if wantSpeaker && !Self.external(session.currentRoute) { try? session.overrideOutputAudioPort(.speaker) }
  }

  private static func onSpeaker(_ route: AVAudioSessionRouteDescription) -> Bool {
    route.outputs.contains { $0.portType == .builtInSpeaker }
  }

  /// Headphones, AirPods, a car: the user plugged something in, so their
  /// speaker choice gives way to it (as on a phone call).
  private static func external(_ route: AVAudioSessionRouteDescription) -> Bool {
    route.outputs.contains {
      [.headphones, .bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .carAudio, .airPlay, .usbAudio].contains($0.portType)
    }
  }

  private func routeChanged(_ note: Notification) {
    let session = AVAudioSession.sharedInstance()
    let route = session.currentRoute
    if Self.external(route) {
      wantSpeaker = false
    } else if wantSpeaker && !Self.onSpeaker(route) {
      // Put the user's choice back; the override's own change comes round
      // again with the speaker on, so this can't loop.
      try? session.overrideOutputAudioPort(.speaker)
    }
    sendEvent("onRoute", ["speaker": Self.onSpeaker(session.currentRoute), "wanted": wantSpeaker])
  }

  /// A player per sound file, created once (on `cueQueue`) and reused.
  private func player(_ uri: String) -> AVAudioPlayer? {
    if let existing = cues[uri] { return existing }
    guard let url = URL(string: uri), let made = try? AVAudioPlayer(contentsOf: url) else { return nil }
    made.prepareToPlay()
    cues[uri] = made
    return made
  }

  public func definition() -> ModuleDefinition {
    Name("PewAudioRoute")

    /// The call's real output, every time it changes: `speaker` (on the
    /// loudspeaker now) and `wanted` (the user's choice, still held).
    Events("onRoute")

    OnStartObserving {
      guard self.routeObserver == nil else { return }
      self.routeObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
      ) { [weak self] note in self?.routeChanged(note) }
      self.interruptionObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
      ) { [weak self] note in self?.interrupted(note) }
    }

    OnStopObserving {
      for observer in [self.routeObserver, self.interruptionObserver].compactMap({ $0 }) {
        NotificationCenter.default.removeObserver(observer)
      }
      self.routeObserver = nil
      self.interruptionObserver = nil
    }

    /// The screen goes dark when the phone is held to the ear during a call
    /// (as the Phone app does), so a cheek can't press End or Mute.
    Function("setProximity") { (on: Bool) in
      DispatchQueue.main.async { UIDevice.current.isProximityMonitoringEnabled = on }
    }

    /// The call's session mode: voice chat, the mode phone and FaceTime calls
    /// use, which turns on the system's echo cancellation tuned for speech
    /// (on the loudspeaker too). Set before the mic opens, never after: a
    /// session reconfigured under WebRTC's running audio unit deadlocked Core
    /// Audio. False (never a throw) when it didn't take.
    Function("setVoiceChatMode") { () -> Bool in
      do {
        try AVAudioSession.sharedInstance().setMode(.voiceChat)
        return true
      } catch {
        return false
      }
    }

    /// Every app sound plays here, off the JavaScript thread.
    ///
    /// expo-audio's `play()` is synchronous and activates the audio session
    /// first. Around a call the session is busy (switching into the call's
    /// mode, or WebRTC shutting its audio down, which holds it for seconds),
    /// and that activation froze the whole app: a tap's tick or the end
    /// card's Close sat for five seconds. Here a serial background queue
    /// waits instead, and the screen never does.
    ///
    /// `activate`: make the session active first (a call cue inside the
    /// call's session). Off a call the player activates the ambient session
    /// by itself.
    AsyncFunction("playCue") { (uri: String, volume: Double, at: Double, activate: Bool) in
      self.cueQueue.async {
        guard let player = self.player(uri) else { return }
        if activate { try? AVAudioSession.sharedInstance().setActive(true) }
        player.setVolume(Float(max(0, min(1, volume))), fadeDuration: 0)
        player.currentTime = max(0, at)
        player.play()
      }
    }

    /// Load these now so the first play is not late.
    AsyncFunction("prepareCues") { (uris: [String]) in
      self.cueQueue.async {
        for uri in uris { _ = self.player(uri) }
      }
    }

    /// Fade a sound out over `ms` and stop it.
    AsyncFunction("stopCue") { (uri: String, ms: Double) in
      self.cueQueue.async {
        guard let player = self.cues[uri], player.isPlaying else { return }
        let seconds = max(0, ms) / 1000
        player.setVolume(0, fadeDuration: seconds)
        self.cueQueue.asyncAfter(deadline: .now() + seconds) {
          if player.volume == 0 { player.stop() }
        }
      }
    }

    /// Whether this is the simulator, which has no hardware echo cancellation:
    /// there the call keeps the mic closed while Pew talks (its voice comes
    /// out of the Mac's speakers and straight back in). On a phone the
    /// voice-processing audio unit cancels it, so the user can talk over Pew.
    Function("isSimulator") { () -> Bool in
      #if targetEnvironment(simulator)
        return true
      #else
        return false
      #endif
    }

    /// True when the switch took. False (never a throw) when the session is not
    /// in a category that can be overridden, e.g. before the call's mic opens.
    /// The choice is held either way (`wantSpeaker`), so one that can't take
    /// yet (the call's audio still starting) takes on the next route change.
    Function("setSpeaker") { (on: Bool) -> Bool in
      self.wantSpeaker = on
      let session = AVAudioSession.sharedInstance()
      do {
        try session.overrideOutputAudioPort(on ? .speaker : .none)
        return true
      } catch {
        return false
      }
    }

    /// Whether the call is playing through the built-in loudspeaker right now.
    Function("isSpeaker") { () -> Bool in
      AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType == .builtInSpeaker }
    }
  }
}
