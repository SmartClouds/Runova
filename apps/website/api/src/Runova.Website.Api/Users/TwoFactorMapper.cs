using Riok.Mapperly.Abstractions;
using Runova.Website.Core.Accounts;

namespace Runova.Website.Api.Users;

/// <summary>The step-up proof sent with turning two-factor on.</summary>
[Mapper]
internal static partial class TwoFactorMapper
{
    /// <summary>
    /// The proof part of the request. Its <c>code</c> is the new authenticator's first code, never
    /// step-up proof, so the proof carries no code.
    /// </summary>
    [MapperIgnoreSource(nameof(TwoFactorEnableRequest.Code))]
    [MapValue(nameof(StepUpRequest.Code), Use = nameof(NoCode))]
    public static partial StepUpRequest ToStepUp(TwoFactorEnableRequest request);

    private static string? NoCode() => null;
}
