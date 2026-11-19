using System.Globalization;
using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Accounts;

namespace Runova.Website.Api.Accounts;

[Mapper]
internal static partial class SignInSettingsMapper
{
    /// <summary>
    /// What each provider does in force (the environment may fill in for the row), the callback
    /// addresses and the count of accounts with only a provider to sign in with come from
    /// elsewhere, so the caller passes them. A secret only shows as saved or not.
    /// </summary>
    [MapProperty(nameof(SignInSettings.TurnstileSecretSealed), nameof(SignInSettingsDto.HasTurnstileSecret), Use = nameof(IsSaved))]
    [MapProperty(nameof(SignInSettings.GoogleClientSecretSealed), nameof(SignInSettingsDto.HasGoogleClientSecret), Use = nameof(IsSaved))]
    [MapProperty(nameof(SignInSettings.ApplePrivateKeySealed), nameof(SignInSettingsDto.HasApplePrivateKey), Use = nameof(IsSaved))]
    [MapProperty(nameof(SignInSettings.MicrosoftClientSecretSealed), nameof(SignInSettingsDto.HasMicrosoftClientSecret), Use = nameof(IsSaved))]
    public static partial SignInSettingsDto ToDto(
        SignInSettings row,
        bool googleActive,
        bool googleFromEnvironment,
        string googleCallbackUrl,
        bool appleActive,
        bool appleFromEnvironment,
        string appleCallbackUrl,
        bool microsoftActive,
        bool microsoftFromEnvironment,
        string microsoftCallbackUrl,
        int externalOnlyAccounts);

    private static string VersionToString(uint version) => version.ToString(CultureInfo.InvariantCulture);

    [UserMapping(Default = false)]
    private static bool IsSaved(string? sealedSecret) => sealedSecret is not null;
}
