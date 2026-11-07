using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Security;

[Mapper]
internal static partial class AuthMapper
{
    /// <summary>What the device signs; the device, purpose and session it is bound to stay here.</summary>
    [MapProperty(nameof(IssuedChallenge.Id), nameof(ChallengeResponse.ChallengeId))]
    [MapProperty(nameof(IssuedChallenge.ExpiresAt), nameof(ChallengeResponse.ExpiresAtUnixMs))]
    public static partial ChallengeResponse ToResponse(IssuedChallenge issued);

    /// <summary>
    /// The user a sign-in is for. Roles live in their own table and two-factor comes from the user
    /// manager, so the caller passes both; hashes and stamps stay on the server.
    /// </summary>
    [MapperIgnoreSource(nameof(CoreUser.TwoFactorEnabled))]
    [MapProperty(nameof(CoreUser.UserName), nameof(SignedInUser.UserName), Use = nameof(NameOf))]
    public static partial SignedInUser ToSignedInUser(CoreUser user, string[] roles, bool twoFactorEnabled);

    private static string NameOf(string? userName) => userName ?? string.Empty;
}
