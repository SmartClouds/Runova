using System.Text.RegularExpressions;
using Runova.Website.Core.Audit;

namespace Runova.Website.Tests.Audit;

public sealed partial class AuditActionsTests
{
    [Fact]
    public void The_actions_are_the_ones_the_contract_lists()
    {
        var contract = Contract.Read();
        var start = contract.IndexOf("Actions are `<resource>.<verb>`:", StringComparison.Ordinal);
        var end = contract.IndexOf("Entries are never changed", start, StringComparison.Ordinal);

        var listed = Action().Matches(contract[start..end]).Select(m => m.Groups[1].Value).ToHashSet();

        Assert.Equal(listed.Order(StringComparer.Ordinal), AuditActions.All.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void The_actor_kinds_are_the_ones_the_contract_lists() =>
        Assert.Equal(["api-client", "system", "user"], AuditActorKinds.All.Order(StringComparer.Ordinal));

    [GeneratedRegex(@"`([a-z-]+\.[a-z-]+)`")]
    private static partial Regex Action();
}
