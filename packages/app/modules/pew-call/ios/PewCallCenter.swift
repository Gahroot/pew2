import AVFoundation
import CallKit
import Foundation
import PushKit
import WebRTC

/// The one place PushKit and CallKit live, for the life of the process.
///
/// Created from the app delegate at launch (`PewCallAppDelegate`), because a
/// VoIP push can launch a killed app in the background, and iOS then expects
/// the push registry to exist and the call to be reported before JavaScript
/// has even loaded. Events for JavaScript are queued until it says `ready`.
final class PewCallCenter: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
  static let shared = PewCallCenter()

  /// A ring nobody answers is ended as missed after this long.
  private let ringTimeout: TimeInterval = 30

  private var registry: PKPushRegistry?
  private var provider: CXProvider?
  private(set) var token: String?
  private var activeCall: UUID?
  private var activeRing: [String: Any] = [:]
  private var answered = false
  private var timeout: DispatchWorkItem?

  private var jsReady = false
  private var pending: [[String: Any]] = []
  /// Set by the module while JavaScript listens.
  var emit: ((String, [String: Any]) -> Void)?

  /// CallKit is not allowed for apps on China's App Store.
  static var allowed: Bool {
    let region: String?
    if #available(iOS 16, *) {
      region = Locale.current.region?.identifier
    } else {
      region = Locale.current.regionCode
    }
    return region?.uppercased() != "CN"
  }

  /// Which APNs this build's tokens belong to: a development profile's
  /// `aps-environment`, or production when there is no profile (App Store, TestFlight).
  static var apnsEnvironment: String {
    guard
      let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
      let data = try? Data(contentsOf: url),
      let text = String(data: data, encoding: .isoLatin1),
      let start = text.range(of: "<plist"),
      let end = text.range(of: "</plist>"),
      let plistData = String(text[start.lowerBound..<end.upperBound]).data(using: .isoLatin1),
      let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any],
      let entitlements = plist["Entitlements"] as? [String: Any],
      let env = entitlements["aps-environment"] as? String
    else { return "production" }
    return env == "development" ? "sandbox" : "production"
  }

  func start() {
    guard Self.allowed, registry == nil else { return }
    let config: CXProviderConfiguration
    if #available(iOS 14, *) {
      config = CXProviderConfiguration()
    } else {
      config = CXProviderConfiguration(localizedName: "pew2")
    }
    config.supportsVideo = false
    config.maximumCallGroups = 1
    config.maximumCallsPerCallGroup = 1
    config.supportedHandleTypes = [.generic]
    // Pew is not a person: keep it out of the Phone app's Recents.
    config.includesCallsInRecents = false
    let provider = CXProvider(configuration: config)
    provider.setDelegate(self, queue: nil)
    self.provider = provider

    let registry = PKPushRegistry(queue: .main)
    registry.delegate = self
    registry.desiredPushTypes = [.voIP]
    self.registry = registry
  }

  // MARK: JavaScript

  func markReady() {
    jsReady = true
  }

  func takePending() -> [[String: Any]] {
    let out = pending
    pending = []
    return out
  }

  private func send(_ type: String, _ body: [String: Any] = [:]) {
    var event = body
    event["type"] = type
    if jsReady, let emit {
      emit("onCall", event)
    } else {
      pending.append(event)
    }
  }

  /// JavaScript ended the call (hung up in the app, or it failed): take it off the system UI.
  func endFromApp() {
    guard let call = activeCall else { return }
    provider?.reportCall(with: call, endedAt: Date(), reason: .remoteEnded)
    finish()
  }

  /// JavaScript's call connected: show the call as connected on the system UI.
  func connected() {
    guard let call = activeCall else { return }
    provider?.reportOutgoingCall(with: call, connectedAt: Date())
  }

  private func finish() {
    timeout?.cancel()
    timeout = nil
    // Back to WebRTC starting its own audio, for calls placed in the app.
    RTCAudioSession.sharedInstance().useManualAudio = false
    activeCall = nil
    activeRing = [:]
    answered = false
  }

  // MARK: PushKit

  func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
    let hex = credentials.token.map { String(format: "%02x", $0) }.joined()
    token = hex
    emit?("onToken", ["token": hex, "env": Self.apnsEnvironment])
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    token = nil
    emit?("onToken", ["token": NSNull(), "env": Self.apnsEnvironment])
  }

  func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    let pew = payload.dictionaryPayload["pew"] as? [String: Any] ?? [:]
    reportIncoming(pew, completion: completion)
  }

  /// Report the ring to CallKit at once. Every VoIP push must end here: one
  /// that doesn't report a call gets the app killed and pushes cut off.
  func reportIncoming(_ pew: [String: Any], completion: (() -> Void)? = nil) {
    guard let provider else {
      completion?()
      return
    }

    let uuid = UUID()
    let update = CXCallUpdate()
    let title = (pew["title"] as? String) ?? "Pew"
    update.remoteHandle = CXHandle(type: .generic, value: title)
    update.localizedCallerName = title
    update.hasVideo = false
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false

    // Already on a call: iOS still wants this one reported, then it's let go.
    let busy = activeCall != nil
    provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
      defer { completion?() }
      guard let self else { return }
      if error != nil { return }
      if busy {
        provider.reportCall(with: uuid, endedAt: Date(), reason: .answeredElsewhere)
        return
      }
      self.activeCall = uuid
      self.activeRing = pew
      self.answered = false
      self.send("ringing", ["focus": pew["focus"] ?? NSNull(), "ring": pew["ring"] ?? NSNull()])
      let work = DispatchWorkItem { [weak self] in
        guard let self, self.activeCall == uuid, !self.answered else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: .unanswered)
        self.send("missed", ["ring": pew["ring"] ?? NSNull()])
        self.finish()
      }
      self.timeout = work
      DispatchQueue.main.asyncAfter(deadline: .now() + self.ringTimeout, execute: work)
    }
  }

  // MARK: CallKit

  func providerDidReset(_ provider: CXProvider) {
    if activeCall != nil { send("hangup") }
    finish()
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard action.callUUID == activeCall else {
      action.fail()
      return
    }
    answered = true
    timeout?.cancel()
    // The call's audio, set before CallKit activates the session: voice chat
    // (hardware echo cancellation), Bluetooth both ways for AirPods.
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
    // On a system call WebRTC may start its audio only once CallKit has
    // activated the session (`didActivate`), never before: started early it
    // fights CallKit for the session, and the call is silent both ways
    // (WebRTC's RTCAudioSession.h). Set here, at the answer, not at the
    // ring, so a ring can never silence a call already on.
    RTCAudioSession.sharedInstance().useManualAudio = true
    RTCAudioSession.sharedInstance().isAudioEnabled = false
    send("answer", ["focus": activeRing["focus"] ?? NSNull(), "ring": activeRing["ring"] ?? NSNull()])
    action.fulfill()
    // iOS can skip `didActivate` on a call answered from a cold launch; then
    // WebRTC's audio would never start. Give it a moment, then start it.
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
      guard let self, self.activeCall != nil, self.answered else { return }
      let rtc = RTCAudioSession.sharedInstance()
      guard rtc.useManualAudio, !rtc.isAudioEnabled else { return }
      rtc.audioSessionDidActivate(AVAudioSession.sharedInstance())
      rtc.isAudioEnabled = true
    }
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    if action.callUUID == activeCall {
      send(answered ? "hangup" : "declined", ["ring": activeRing["ring"] ?? NSNull()])
      finish()
    }
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    send("mute", ["muted": action.isMuted])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    // CallKit owns the session on a system call: hand it to WebRTC's audio unit.
    RTCAudioSession.sharedInstance().audioSessionDidActivate(audioSession)
    RTCAudioSession.sharedInstance().isAudioEnabled = true
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    RTCAudioSession.sharedInstance().audioSessionDidDeactivate(audioSession)
    RTCAudioSession.sharedInstance().isAudioEnabled = false
  }
}
