import ExpoModulesCore
import UIKit

/// Starts PushKit and CallKit at launch, before JavaScript: a VoIP push that
/// launches a killed app must find them ready.
public class PewCallAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    PewCallCenter.shared.start()
    return true
  }
}
