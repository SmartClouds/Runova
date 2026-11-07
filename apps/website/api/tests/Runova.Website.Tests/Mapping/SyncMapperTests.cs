using Runova.Website.Api.Accounts;
using Runova.Website.Data.Accounts;

namespace Runova.Website.Tests.Mapping;

public class SyncMapperTests
{
    private static readonly DateTimeOffset _at = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public void A_scope_takes_its_name_and_rights_from_the_access_and_the_rest_from_the_scope()
    {
        var scope = new SyncScope
        {
            Id = 5,
            Kind = SyncScopeKinds.Team,
            TeamId = 2,
            LatestRevision = 77,
            Epoch = 3,
            KeyVersion = 4,
            KeyEnvelope = "{}",
            EncryptServers = true,
            EncryptEnvironments = false,
            EncryptEverything = true,
        };

        var dto = SyncMapper.ToDto(new ScopeAccess(scope, "Ops", CanWrite: true, CanManage: false));

        Assert.Equal(new SyncScopeDto(5, "team", 2, "Ops", true, false, 77, 3, 4, new SyncPolicyDto(true, false, true)), dto);
    }

    [Fact]
    public void A_record_maps_to_its_dto_and_to_what_a_push_accepted()
    {
        var record = new SyncRecord
        {
            Id = 1,
            ScopeId = 5,
            Collection = "servers",
            ItemId = "a1",
            Revision = 12,
            Deleted = false,
            Encryption = "e2e",
            KeyVersion = 2,
            Payload = "cGF5bG9hZA",
            Size = 7,
            UpdatedAt = _at,
            UpdatedBy = 3,
        };

        Assert.Equal(new SyncRecordDto("servers", "a1", 12, false, "e2e", 2, "cGF5bG9hZA", _at), SyncMapper.ToDto(record));
        Assert.Equal(new SyncAcceptedDto("servers", "a1", 12), SyncMapper.ToAcceptedDto(record));
    }

    [Fact]
    public void The_dtos_carry_no_secret()
    {
        Assert.Empty(SecretProperties.In(typeof(SyncScopeDto)));
        Assert.Empty(SecretProperties.In(typeof(SyncRecordDto)));
        Assert.Empty(SecretProperties.In(typeof(SyncAcceptedDto)));
    }
}
