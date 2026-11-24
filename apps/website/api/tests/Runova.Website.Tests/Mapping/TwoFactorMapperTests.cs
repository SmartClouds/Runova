using System.Text.Json;
using Runova.Website.Api.Users;
using Runova.Website.Core.Accounts;

namespace Runova.Website.Tests.Mapping;

public class TwoFactorMapperTests
{
    [Fact]
    public void The_proof_carries_the_password_and_passkey_answer()
    {
        var credential = JsonElement.Parse("""{ "id": "AQI" }""");

        var stepUp = TwoFactorMapper.ToStepUp(new TwoFactorEnableRequest("123456", "correct horse battery", "challenge-1", credential));

        Assert.Equal("correct horse battery", stepUp.Password);
        Assert.Equal("challenge-1", stepUp.PasskeyChallengeId);
        Assert.Equal("AQI", stepUp.PasskeyCredential!.Value.GetProperty("id").GetString());
    }

    [Fact]
    public void The_new_authenticator_code_is_never_taken_as_step_up_proof()
    {
        var stepUp = TwoFactorMapper.ToStepUp(new TwoFactorEnableRequest("123456"));

        Assert.Equal(new StepUpRequest(null, null, null, null), stepUp);
    }
}
