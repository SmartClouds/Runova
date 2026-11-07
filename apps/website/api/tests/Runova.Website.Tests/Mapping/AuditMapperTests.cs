using Runova.Website.Api.Audit;
using Runova.Website.Data.Audit;

namespace Runova.Website.Tests.Mapping;

public class AuditMapperTests
{
    [Fact]
    public void An_entry_projects_without_what_changed()
    {
        var at = new DateTimeOffset(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);
        var entry = new AuditEntry
        {
            Id = 11,
            At = at,
            ActorKind = "user",
            ActorId = 3,
            Action = "user.invite",
            TargetType = "user",
            TargetId = "4",
            Ip = "203.0.113.2",
            Changes = """{"email":"kim@example.com"}""",
        };

        var dto = Assert.Single(new[] { entry }.AsQueryable().ProjectToDto());

        Assert.Equal(new AuditEntryDto(11, at, "user", 3, "user.invite", "user", "4", "203.0.113.2"), dto);
        Assert.Empty(SecretProperties.In(typeof(AuditEntryDto)));
    }
}
