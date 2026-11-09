using Runova.Website.Api.Accounts;
using Runova.Website.Core.Billing;

namespace Runova.Website.Tests.Mapping;

public class EncryptionMapperTests
{
    [Fact]
    public void An_item_is_its_id_label_and_state()
    {
        var dto = EncryptionMapper.ToDto(new EncryptionItem("sync", "Cloud sync"), enabled: true, active: false, lapsed: true, needsKey: false);

        Assert.Equal(new EncryptionItemDto("sync", "Cloud sync", true, false, true, false), dto);
        Assert.Empty(SecretProperties.In(typeof(EncryptionItemDto)));
    }

    [Fact]
    public void The_answer_names_the_plan_and_whether_it_includes_this()
    {
        var items = new[] { new EncryptionItemDto("sync", "Cloud sync", false, false, false, true) };

        var dto = EncryptionMapper.ToDto(new Entitlement(3, "pro", "Pro", 50, 60, 90, false, true), items);

        Assert.True(dto.Entitled);
        Assert.Equal("Pro", dto.PlanName);
        Assert.Equal(items, dto.Items);
        Assert.Empty(SecretProperties.In(typeof(EncryptionDto)));
    }
}
