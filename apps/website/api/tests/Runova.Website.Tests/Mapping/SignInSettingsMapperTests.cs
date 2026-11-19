using Runova.Website.Api.Accounts;
using Runova.Website.Data.Accounts;

namespace Runova.Website.Tests.Mapping;

public class SignInSettingsMapperTests
{
    [Fact]
    public void The_settings_show_whether_a_secret_is_saved_and_take_the_rest_from_the_caller()
    {
        var updatedAt = new DateTimeOffset(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);
        var row = new SignInSettings
        {
            CaptchaEnabled = true,
            TurnstileSiteKey = "site-key",
            TurnstileSecretSealed = "sealed",
            GoogleEnabled = true,
            GoogleClientId = "client-id",
            GoogleClientSecretSealed = null,
            AppleEnabled = false,
            AppleServicesId = "com.runovahq.web",
            AppleTeamId = "TEAM123456",
            AppleKeyId = "KEY1234567",
            ApplePrivateKeySealed = "sealed-key",
            AppleBundleId = "com.runovahq.app",
            MicrosoftEnabled = true,
            MicrosoftClientId = "ms-client",
            MicrosoftClientSecretSealed = null,
            UpdatedAt = updatedAt,
            Version = 12,
        };

        var dto = SignInSettingsMapper.ToDto(
            row,
            googleActive: true,
            googleFromEnvironment: true,
            "https://runovahq.com/google",
            appleActive: false,
            appleFromEnvironment: false,
            "https://runovahq.com/apple",
            microsoftActive: true,
            microsoftFromEnvironment: true,
            "https://runovahq.com/microsoft",
            externalOnlyAccounts: 2);

        Assert.Equal(
            new SignInSettingsDto(
                true, "site-key", true,
                true, true, "client-id", false, true, "https://runovahq.com/google",
                false, false, "com.runovahq.web", "TEAM123456", "KEY1234567", true, "com.runovahq.app", false, "https://runovahq.com/apple",
                true, true, "ms-client", false, true, "https://runovahq.com/microsoft",
                2, updatedAt, "12"),
            dto);
    }

    [Fact]
    public void The_dto_carries_no_secret()
    {
        // Only flags saying a secret is saved.
        Assert.Equal(
            ["HasTurnstileSecret", "HasGoogleClientSecret", "HasApplePrivateKey", "HasMicrosoftClientSecret"],
            SecretProperties.In(typeof(SignInSettingsDto)));
    }
}
