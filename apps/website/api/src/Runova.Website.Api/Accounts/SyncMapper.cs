using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Accounts;

namespace Runova.Website.Api.Accounts;

[Mapper]
internal static partial class SyncMapper
{
    [MapNestedProperties(nameof(ScopeAccess.Scope))]
    [MapProperty(nameof(ScopeAccess.Scope), nameof(SyncScopeDto.Policy))]
    public static partial SyncScopeDto ToDto(ScopeAccess access);

    public static partial SyncRecordDto ToDto(SyncRecord record);

    public static partial SyncAcceptedDto ToAcceptedDto(SyncRecord record);

    [MapProperty(nameof(SyncScope.EncryptServers), nameof(SyncPolicyDto.Servers))]
    [MapProperty(nameof(SyncScope.EncryptEnvironments), nameof(SyncPolicyDto.Environments))]
    [MapProperty(nameof(SyncScope.EncryptEverything), nameof(SyncPolicyDto.Everything))]
    private static partial SyncPolicyDto ToPolicy(SyncScope scope);
}
