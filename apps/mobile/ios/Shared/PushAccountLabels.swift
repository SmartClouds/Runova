import Foundation
import Security

/// Whose each push is, kept where the notification extension can reach it (E118): a map from the
/// tag a push carries to the email of its account, as JSON. It is only there while the phone holds
/// more than one account. The extension gets these labels, never the accounts' tokens.
enum PushAccountLabels {
    private static let account = "push-account-labels"
    // The same service and group as the notification secret.
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

    /// The labels as they are stored.
    static func encode(_ labels: [String: String]) -> String? {
        guard let data = try? JSONEncoder().encode(labels) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Stored labels back as a map. Anything unreadable is no labels at all.
    static func decode(_ text: String?) -> [String: String] {
        guard let text, let labels = try? JSONDecoder().decode([String: String].self, from: Data(text.utf8))
        else { return [:] }
        return labels
    }

    static func read() -> [String: String] {
        guard var request = query() else { return [:] }
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess,
            let data = item as? Data
        else { return [:] }
        return decode(String(data: data, encoding: .utf8))
    }

    static func write(_ labels: [String: String]) {
        guard let base = query(), let text = encode(labels) else { return }
        let data = Data(text.utf8)
        let update = [kSecValueData as String: data]
        if SecItemUpdate(base as CFDictionary, update as CFDictionary) == errSecItemNotFound {
            var add = base
            add[kSecValueData as String] = data
            // A push can arrive while the phone is locked.
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    static func remove() {
        guard let base = query() else { return }
        SecItemDelete(base as CFDictionary)
    }
}
