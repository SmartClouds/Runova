using Riok.Mapperly.Abstractions;
using Runova.Website.Core.Billing;

namespace Runova.Website.Api.Accounts;

[Mapper(RequiredMappingStrategy = RequiredMappingStrategy.Target)]
internal static partial class EncryptionMapper
{
    [MapProperty(nameof(EncryptionItem.Id), nameof(EncryptionItemDto.Item))]
    public static partial EncryptionItemDto ToDto(EncryptionItem item, bool enabled, bool active, bool lapsed, bool needsKey);

    [MapProperty(nameof(Entitlement.EncryptedItems), nameof(EncryptionDto.Entitled))]
    [MapProperty(nameof(Entitlement.Name), nameof(EncryptionDto.PlanName))]
    public static partial EncryptionDto ToDto(Entitlement entitlement, IReadOnlyList<EncryptionItemDto> items);
}
