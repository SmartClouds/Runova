using System.Globalization;
using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Accounts;

namespace Runova.Website.Api.Accounts;

[Mapper]
internal static partial class SignInSettingsMapper
{
    /// <summary>
    /// What Google sign-in does in force (the environment may fill in for the row), the callback
    /// address and the count of Google-only accounts come from elsewhere, so the caller passes them.
    /// A secret only shows as saved or not.
    /// </summary>
    [MapProperty(nameof(SignInSettings.TurnstileSecretSealed), nameof(SignInSettingsDto.HasTurnstileSecret), Use = nameof(IsSaved))]
    [MapProperty(nameof(SignInSettings.GoogleClientSecretSealed), nameof(SignInSettingsDto.HasGoogleClientSecret), Use = nameof(IsSaved))]
    public static partial SignInSettingsDto ToDto(
        SignInSettings row, bool googleActive, bool googleFromEnvironment, string googleCallbackUrl, int googleOnlyAccounts);

    private static string VersionToString(uint version) => version.ToString(CultureInfo.InvariantCulture);

    [UserMapping(Default = false)]
    private static bool IsSaved(string? sealedSecret) => sealedSecret is not null;
}
