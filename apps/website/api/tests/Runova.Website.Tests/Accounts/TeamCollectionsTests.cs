using System.Text.RegularExpressions;
using Runova.Website.Api.Accounts;

namespace Runova.Website.Tests.Accounts;

/// <summary>The collections a team scope takes are the ones the desktop app marks shareable.</summary>
public sealed partial class TeamCollectionsTests
{
    [Fact]
    public void A_team_scope_takes_exactly_the_shareable_collections()
    {
        var policy = File.ReadAllText(FindPolicy());
        var shareable = CollectionEntry().Matches(policy)
            .Where(m => m.Groups["shareable"].Value == "true")
            .Select(m => m.Groups["id"].Value)
            .Order(StringComparer.Ordinal);

        Assert.Equal(shareable, SyncEndpoints.TeamCollections.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Settings_never_go_to_a_team() => Assert.DoesNotContain("settings", SyncEndpoints.TeamCollections);

    private static string FindPolicy()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "packages", "core", "src", "sync", "policy.ts");
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new FileNotFoundException("packages/core/src/sync/policy.ts was not found above the test binary.");
    }

    // One entry of SYNC_COLLECTIONS: its id, then (before the next id) its shareable flag.
    [GeneratedRegex(@"id: '(?<id>[a-z][a-z0-9-]+)',(?:(?!id: ')[\s\S])*?shareable: (?<shareable>true|false)", RegexOptions.CultureInvariant)]
    private static partial Regex CollectionEntry();
}
