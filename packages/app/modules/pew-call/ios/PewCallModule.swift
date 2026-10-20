import ExpoModulesCore

/// JavaScript's side of `PewCallCenter`: the VoIP token, the call's events
/// (ringing, answer, declined, missed, hangup, mute), and ending the call.
public class PewCallModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PewCall")

    Events("onCall", "onToken")

    OnStartObserving {
      PewCallCenter.shared.emit = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
    }

    OnStopObserving {
      PewCallCenter.shared.emit = nil
    }

    /// Whether this phone may ring with CallKit (false in China).
    Function("allowed") { () -> Bool in
      PewCallCenter.allowed
    }

    /// The VoIP token and its APNs environment, once iOS has handed one over.
    Function("token") { () -> [String: Any]? in
      guard let token = PewCallCenter.shared.token else { return nil }
      return ["token": token, "env": PewCallCenter.apnsEnvironment]
    }

    /// JavaScript is listening: return what happened before (a ring answered
    /// from the lock screen launched the app), then send events live.
    Function("ready") { () -> [[String: Any]] in
      let events = PewCallCenter.shared.takePending()
      PewCallCenter.shared.markReady()
      return events
    }

    Function("endCall") {
      PewCallCenter.shared.endFromApp()
    }

    Function("connected") {
      PewCallCenter.shared.connected()
    }

    /// Development only: show the incoming-call screen without a push.
    Function("simulateRing") { (body: String) in
      #if DEBUG
        PewCallCenter.shared.reportIncoming(["title": "Pew", "body": body, "ring": "dev"])
      #endif
    }
  }
}
