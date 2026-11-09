using Runova.Website.Api.Accounts;
using Runova.Website.Data.Accounts;

namespace Runova.Website.Tests.Mapping;

public class QrSignInMapperTests
{
    private static readonly DateTimeOffset _expires = new(2026, 11, 9, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void A_new_code_carries_its_id_text_and_end()
    {
        var dto = QrSignInMapper.ToDto(new QrSignIn { Id = 7, CodeHash = [1, 2], ExpiresAt = _expires }, "rq1.code");

        Assert.Equal(new QrSignInDto(7, "rq1.code", _expires), dto);
    }

    [Fact]
    public void A_status_shows_the_match_code_and_never_the_hash_or_challenge()
    {
        var dto = QrSignInMapper.ToStatusDto(new QrSignIn { Id = 7, CodeHash = [1, 2], CodeChallenge = "challenge", MatchCode = "0420", ExpiresAt = _expires }, "scanned");

        Assert.Equal(new QrSignInStatusDto("scanned", "0420", _expires), dto);
        Assert.Empty(SecretProperties.In(typeof(QrSignInStatusDto)));
        Assert.Empty(SecretProperties.In(typeof(QrSignInDto)));
    }
}
