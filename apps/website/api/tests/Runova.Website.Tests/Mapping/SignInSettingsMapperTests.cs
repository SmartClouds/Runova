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
            UpdatedAt = updatedAt,
            Version = 12,
        };

        var dto = SignInSettingsMapper.ToDto(row, googleActive: true, googleFromEnvironment: true, "https://runovahq.com/callback", 2);

        Assert.Equal(
            new SignInSettingsDto(true, "site-key", true, true, true, "client-id", false, true, "https://runovahq.com/callback", 2, updatedAt, "12"),
            dto);
    }

    [Fact]
    public void The_dto_carries_no_secret()
    {
        // Only flags saying a secret is saved.
        Assert.Equal(["HasTurnstileSecret", "HasGoogleClientSecret"], SecretProperties.In(typeof(SignInSettingsDto)));
    }
}
