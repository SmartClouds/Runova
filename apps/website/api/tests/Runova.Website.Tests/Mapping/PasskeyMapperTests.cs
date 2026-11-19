using Microsoft.AspNetCore.Identity;
using Runova.Website.Api.Accounts;
using Runova.Website.Core.Accounts;

namespace Runova.Website.Tests.Mapping;

public class PasskeyMapperTests
{
    private static readonly DateTimeOffset _at = new(2026, 11, 19, 8, 0, 0, TimeSpan.Zero);

    private static UserPasskeyInfo Passkey(string? name) =>
        new(
            credentialId: [0xfb, 0xff, 0x01],
            publicKey: [9, 9, 9],
            createdAt: _at,
            signCount: 4,
            transports: ["internal"],
            isUserVerified: true,
            isBackupEligible: true,
            isBackedUp: true,
            attestationObject: [7],
            clientDataJson: [8])
        {
            Name = name,
        };

    [Fact]
    public void A_passkey_shows_its_base64url_id_name_date_and_whether_it_syncs()
    {
        var dto = PasskeyMapper.ToDto(Passkey("Work laptop"));

        Assert.Equal(new PasskeyDto("-_8B", "Work laptop", _at, true), dto);
    }

    [Fact]
    public void A_passkey_with_no_name_is_called_passkey()
    {
        Assert.Equal("Passkey", PasskeyMapper.ToDto(Passkey(null)).Name);
    }

    [Fact]
    public void A_passkey_never_carries_its_key_or_attestation()
    {
        Assert.Empty(SecretProperties.In(typeof(PasskeyDto)));
        Assert.Equal(["Id", "Name", "CreatedAt", "Synced"], typeof(PasskeyDto).GetProperties().Select(p => p.Name));
    }
}
