using Riok.Mapperly.Abstractions;
using Runova.Website.Core.Billing;
using Runova.Website.Data.Billing;

namespace Runova.Website.Api.Billing;

[Mapper(RequiredMappingStrategy = RequiredMappingStrategy.Target)]
internal static partial class EntitlementMapper
{
    [MapProperty(nameof(AccountType.Id), nameof(Entitlement.AccountTypeId))]
    public static partial Entitlement ToEntitlement(AccountType type);
}
