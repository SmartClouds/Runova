import Foundation
import Security

/// The key that opens sealed notifications, kept where the notification extension can reach it.
/// The extension gets only this, never the phone's identity.
enum NotificationSecret {
    private static let account = "notification-secret"
    private static let service = "com.runovahq.app.shared"

    private static var group: String? {
        Bundle.main.object(forInfoDictionaryKey: "RunovaKeychainGroup") as? String
    }

    private static func query() -> [String: Any]? {
        guard let group else { return nil }
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: group,
        ]
    }

    static func read() -> String? {
        guard var request = query() else { return nil }
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess,
            let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func store(_ value: String) {
        guard let base = query() else { return }
        let data = Data(value.utf8)
        let update = [kSecValueData as String: data]
        if SecItemUpdate(base as CFDictionary, update as CFDictionary) == errSecItemNotFound {
            var add = base
            add[kSecValueData as String] = data
            // A push can arrive while the phone is locked.
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }
}
