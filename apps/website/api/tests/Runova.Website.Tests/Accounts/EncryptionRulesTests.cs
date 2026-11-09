using Runova.Website.Api.Accounts;
using Runova.Website.Core.Billing;

namespace Runova.Website.Tests.Accounts;

/// <summary>What the switches come to, for each mix of plan, choice, key and scope (E92).</summary>
public class EncryptionRulesTests
{
    private static readonly Entitlement _pro = new(3, "pro", "Pro", 50, 60, 90, false, true);
    private static readonly Entitlement _free = new(1, "free", "Free", 1, 300, 7, true);

    private static HashSet<string> On(params string[] items) => [.. items];

    private static EncryptionItemDto Item(EncryptionDto status, string item) => status.Items.Single(i => i.Item == item);

    [Fact]
    public void Both_items_are_listed_in_order_and_start_off()
    {
        var status = EncryptionRules.Status(_pro, On(), syncSealing: false, syncHasKey: true);

        Assert.True(status.Entitled);
        Assert.Equal("Pro", status.PlanName);
        Assert.Equal(
            [
                new EncryptionItemDto("notifications", "Notifications", false, false, false, false),
                new EncryptionItemDto("sync", "Cloud sync", false, false, false, false),
            ],
            status.Items);
    }

    [Fact]
    public void Notifications_are_active_when_chosen_on_a_plan_that_has_them() =>
        Assert.True(Item(EncryptionRules.Status(_pro, On("notifications"), false, false), "notifications").Active);

    [Fact]
    public void Sync_is_active_only_while_the_scope_really_seals_everything()
    {
        Assert.True(Item(EncryptionRules.Status(_pro, On("sync"), syncSealing: true, syncHasKey: true), "sync").Active);
        Assert.False(Item(EncryptionRules.Status(_pro, On("sync"), syncSealing: false, syncHasKey: true), "sync").Active);
        // Sealing is switched on but there's no key to seal with, as after a key reset.
        Assert.False(Item(EncryptionRules.Status(_pro, On("sync"), syncSealing: true, syncHasKey: false), "sync").Active);
    }

    [Theory]
    [InlineData("notifications")]
    [InlineData("sync")]
    public void A_choice_with_no_plan_behind_it_has_lapsed(string item)
    {
        var dto = Item(EncryptionRules.Status(_free, On(item), syncSealing: true, syncHasKey: true), item);

        Assert.True(dto.Enabled);
        Assert.False(dto.Active);
        Assert.True(dto.Lapsed);
    }

    [Fact]
    public void Only_sync_ever_needs_a_key()
    {
        var status = EncryptionRules.Status(_pro, On(), syncSealing: false, syncHasKey: false);

        Assert.False(Item(status, "notifications").NeedsKey);
        Assert.True(Item(status, "sync").NeedsKey);
    }

    [Theory]
    [InlineData(true, false, true, true, false)] // lost the plan: off, though the choice stays
    [InlineData(true, true, false, false, null)] // on and paid for: untouched, even with no row
    [InlineData(false, true, true, true, true)] // the plan came back
    [InlineData(false, true, true, false, null)] // no key to seal with
    [InlineData(false, true, false, true, null)] // never chosen
    [InlineData(false, false, true, true, null)] // still no plan
    public void A_plan_change_moves_a_scope_only_when_it_has_to(bool sealing, bool entitled, bool wanted, bool hasKey, bool? expected) =>
        Assert.Equal(expected, EncryptionRules.Enforce(sealing, entitled, wanted, hasKey));
}
