import UserNotifications

/// Swaps the generic line on a sealed push for the real one before the phone shows it, and says
/// whose a push is when the phone holds more than one account.
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        handler = contentHandler
        original = request.content
        let info = request.content.userInfo
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        if let sealed = info["sealed"] as? String,
            let category = info["category"] as? String,
            let secret = NotificationSecret.read(),
            let line = openSealedNotification(secret: secret, category: category, sealed: sealed)
        {
            content.body = line
        }
        // Several accounts on the phone: say whose this is, and keep each account's together (E118).
        if let tag = info["account"] as? String, let label = PushAccountLabels.read()[tag] {
            content.subtitle = label
            content.threadIdentifier = "account:\(tag)"
        }
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler, let original { handler(original) }
    }
}
