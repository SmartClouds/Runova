using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Accounts;

namespace Runova.Website.Api.Accounts;

[Mapper(RequiredMappingStrategy = RequiredMappingStrategy.Target)]
internal static partial class QrSignInMapper
{
    public static partial QrSignInDto ToDto(QrSignIn row, string qrText);

    public static partial QrSignInStatusDto ToStatusDto(QrSignIn row, string status);
}
