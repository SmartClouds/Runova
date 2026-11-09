using Runova.Website.Api.Billing;
using Runova.Website.Core.Billing;
using Runova.Website.Data.Billing;

namespace Runova.Website.Tests.Mapping;

public class EntitlementMapperTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void A_type_becomes_what_it_allows(bool encrypted)
    {
        var type = new AccountType
        {
            Id = 3, Key = "pro", Name = "Pro", MaxCloudMonitors = 50, MinIntervalSec = 60, HistoryDays = 90, IsFree = false, EncryptedItems = encrypted,
            StripeProductId = "prod_1",
        };

        Assert.Equal(new Entitlement(3, "pro", "Pro", 50, 60, 90, false, encrypted), EntitlementMapper.ToEntitlement(type));
        Assert.Empty(SecretProperties.In(typeof(Entitlement)));
    }
}
