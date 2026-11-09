import UserNotifications

/// Swaps the generic line on a sealed push for the real one before the phone shows it.
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        handler = contentHandler
        original = request.content
        let info = request.content.userInfo
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent,
            let sealed = info["sealed"] as? String,
            let category = info["category"] as? String,
            let secret = NotificationSecret.read(),
            let line = openSealedNotification(secret: secret, category: category, sealed: sealed)
        else {
            contentHandler(request.content)
            return
        }
        content.body = line
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler, let original { handler(original) }
    }
}
