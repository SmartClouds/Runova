namespace Runova.ServerCore.Compatibility;

/// <summary>
/// Strings that are inputs to encryption, so they must never change. Data Protection derives
/// every key from the application name and the purpose, and the backup format feeds its label
/// and magic into HKDF and the header. Changing any of them would leave every core.db secret and
/// every backup made so far unreadable. Nobody sees them: they never reach a screen, a file name
/// or the wire.
/// </summary>
internal static class FrozenIdentifiers
{
    public const string DataProtectionApplicationName = "runova-core";

    public const string CloudflareDnsTokenPurpose = "Runova.Cloudflare.DnsToken.v1";
    public const string BackupDestinationPurpose = "Runova.Backups.Destination.v1";
    public const string CertificatePrivateKeyPurpose = "Runova.Certificates.PrivateKey.v1";
    public const string AcmeAccountKeyPurpose = "Runova.Acme.AccountKey.v1";
    public const string RegistryCredentialPurpose = "Runova.Registries.Credential.v1";
    public const string TelegramTokenPurpose = "Runova.Notifications.Telegram.Token.v1";
    public const string ErrorReportingDsnPurpose = "Runova.ErrorReporting.Dsn.v1";
    public const string SecondFactorPurpose = "runova-core.identity.second-factor";
    public const string AccessTokenPurpose = "runova-core.access-token.v1";

    /// <summary>HKDF info for a backup's content key (format 2).</summary>
    public const string BackupContentKeyLabel = "Runova backup content key v2";

    /// <summary>The first bytes of every backup file.</summary>
    public const string BackupMagic = "RNBACKUP";
}
