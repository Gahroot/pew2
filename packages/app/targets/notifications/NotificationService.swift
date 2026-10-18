import UserNotifications
import WidgetKit

/// Folds each push into the widget's snapshot, then shows the banner exactly
/// as it arrived.
///
/// The banner is never altered: this exists only because it is the one piece
/// of the app that runs when a push lands on a phone whose app is suspended.
class NotificationService: UNNotificationServiceExtension {
  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let info = request.content.userInfo
    // Expo delivers the message's `data` under "body" on iOS; read the top
    // level too, so a payload shaped differently still finds its session.
    let data = (info["body"] as? [AnyHashable: Any]) ?? info
    if let sessionId = data["sessionId"] as? String, var snapshot = PewSnapshot.load() {
      let kind = (data["kind"] as? String) ?? "finished"
      let badge = (info["aps"] as? [AnyHashable: Any])?["badge"] as? Int
      snapshot.apply(sessionId: sessionId, kind: kind, badge: badge, title: request.content.title, now: Date())
      snapshot.save()
      WidgetCenter.shared.reloadAllTimelines()
    }
    // Synchronously, so the system never has to time this out and the banner
    // is never held back by it.
    contentHandler(request.content)
  }
}
