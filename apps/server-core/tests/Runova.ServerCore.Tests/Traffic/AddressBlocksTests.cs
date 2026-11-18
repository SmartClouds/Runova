using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Tests.Nginx;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// E110 T3, T4, AC2 and AC3: blocking an address saves it and makes nginx refuse it at once,
/// without touching the sites; it is refused for loopback and for the caller's own address; unblock
/// lets it back. Auto-block blocks for the set time, up to the cap, never an app's address, and the
/// prune lets expired blocks go.
/// </summary>
public sealed class AddressBlocksTests : IAsyncLifetime
{
    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_794_996_000_000));

    private readonly NginxKit _kit = new();

    private TestDatabase _database = null!;

    private AddressBlocks _blocks = null!;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static IpKey Key(string address) => IpKey.FromAddress(IPAddress.Parse(address));

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        await _kit.SetUpAsync();
        _blocks = new AddressBlocks(_database.Contexts, new BlockList(_kit.Control, _kit.Applier, NginxKit.Ubuntu, NullLogger<BlockList>.Instance), _clock, NullLogger<AddressBlocks>.Instance);
    }

    public async ValueTask DisposeAsync()
    {
        _blocks.Dispose();
        _kit.Dispose();
        await _database.DisposeAsync();
    }

    private string BlockedFile => _kit.Machine.Text(_kit.Layout.BlockListFile)!;

    [Fact]
    public async Task Blocking_an_address_makes_nginx_refuse_it_and_lists_it()
    {
        var release = await _kit.Machine.ReadLinkAsync(_kit.Layout.CurrentLink, Cancel);

        var result = await _blocks.BlockAsync(new BlockAddressRequest("198.51.100.7", "Scanning for .env", 60, "app"), "maria", Key("203.0.113.50"), Cancel);

        Assert.Empty(result.Problems);
        Assert.Equal(("198.51.100.7", "Scanning for .env", false, "maria", "app"), (result.Blocked!.Network, result.Blocked.Reason, result.Blocked.Automatic, result.Blocked.CreatedBy, result.Blocked.SiteId));
        Assert.Equal(_clock.GetUtcNow().AddMinutes(60).ToUnixTimeMilliseconds(), result.Blocked.ExpiresAtUnixMs);
        Assert.Contains("198.51.100.7 1;", BlockedFile, StringComparison.Ordinal);
        Assert.Equal(release, await _kit.Machine.ReadLinkAsync(_kit.Layout.CurrentLink, Cancel));
        Assert.Single(await _blocks.ListAsync(Cancel));
    }

    [Fact]
    public async Task A_network_blocks_for_good_with_a_reason_of_its_own()
    {
        var result = await _blocks.BlockAsync(new BlockAddressRequest("2001:db8::/32"), "maria", null, Cancel);

        Assert.Null(result.Blocked!.ExpiresAtUnixMs);
        Assert.Equal("Blocked by maria", result.Blocked.Reason);
        Assert.Contains("2001:db8::/32 1;", BlockedFile, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("example.com", "is not an IP address")]
    [InlineData("198.51.100.7/24", "bits set")]
    [InlineData("127.0.0.1", "this server")]
    [InlineData("::1", "this server")]
    [InlineData("0.0.0.0/0", "every address")]
    [InlineData("203.0.113.0/24", "you are connected from")]
    [InlineData("203.0.113.50", "you are connected from")]
    public async Task Some_addresses_cannot_be_blocked(string network, string words)
    {
        var result = await _blocks.BlockAsync(new BlockAddressRequest(network), "maria", Key("203.0.113.50"), Cancel);

        Assert.Contains(words, Assert.Single(result.Problems), StringComparison.Ordinal);
        Assert.Empty(await _blocks.ListAsync(Cancel));
    }

    [Fact]
    public async Task A_block_nginx_refuses_is_not_kept()
    {
        _kit.Machine.TestFailure = machine => machine.Text(_kit.Layout.BlockListFile)!.Contains("198.51.100.7", StringComparison.Ordinal) ? "nginx: [emerg] no" : null;

        var result = await _blocks.BlockAsync(new BlockAddressRequest("198.51.100.7"), "maria", null, Cancel);

        Assert.Contains("nginx", Assert.Single(result.Problems), StringComparison.Ordinal);
        Assert.Empty(await _blocks.ListAsync(Cancel));
    }

    [Fact]
    public async Task Unblocking_lets_the_address_back()
    {
        var blocked = (await _blocks.BlockAsync(new BlockAddressRequest("198.51.100.7"), "maria", null, Cancel)).Blocked!;

        Assert.Equal("198.51.100.7", await _blocks.UnblockAsync(blocked.Id, Cancel));

        Assert.DoesNotContain("198.51.100.7", BlockedFile, StringComparison.Ordinal);
        Assert.Empty(await _blocks.ListAsync(Cancel));
        Assert.Null(await _blocks.UnblockAsync(blocked.Id, Cancel));
    }

    [Fact]
    public async Task Blocking_again_updates_the_block()
    {
        await _blocks.BlockAsync(new BlockAddressRequest("198.51.100.7", Minutes: 10), "maria", null, Cancel);

        var again = await _blocks.BlockAsync(new BlockAddressRequest("198.51.100.7", "For good now"), "olga", null, Cancel);

        var only = Assert.Single(await _blocks.ListAsync(Cancel));
        Assert.Equal((again.Blocked!.Id, "For good now", (long?)null, "olga"), (only.Id, only.Reason, only.ExpiresAtUnixMs, only.CreatedBy));
    }

    [Fact]
    public async Task Auto_block_blocks_for_the_set_time_and_never_an_apps_address()
    {
        var settings = new AutoBlockSettings(true, [AttackKind.Scan], 30, 1000);

        var blocked = await _blocks.AutoBlockAsync(
            [new AutoBlockCandidate(Key("198.51.100.7"), AttackKind.Scan, "app", "app.example.com"), new AutoBlockCandidate(Key("203.0.113.50"), AttackKind.Scan, "app", "app.example.com")],
            settings,
            [Key("203.0.113.50")],
            Cancel);

        Assert.Equal([Key("198.51.100.7")], blocked);
        var row = Assert.Single(await _blocks.ListAsync(Cancel));
        Assert.Equal((true, "Scan on app.example.com", (string?)null), (row.Automatic, row.Reason, row.CreatedBy));
        Assert.Equal(_clock.GetUtcNow().AddMinutes(30).ToUnixTimeMilliseconds(), row.ExpiresAtUnixMs);
    }

    [Fact]
    public async Task Auto_block_stops_at_the_cap_and_skips_what_is_blocked_already()
    {
        await _blocks.BlockAsync(new BlockAddressRequest("198.51.100.0/24"), "maria", null, Cancel);
        var settings = new AutoBlockSettings(true, [AttackKind.Scan], 30, 2);

        var blocked = await _blocks.AutoBlockAsync(
            [.. new[] { "198.51.100.9", "192.0.2.1", "192.0.2.2" }.Select(a => new AutoBlockCandidate(Key(a), AttackKind.Scan, "app", "app.example.com"))],
            settings,
            [],
            Cancel);

        Assert.Equal([Key("192.0.2.1")], blocked);
        Assert.Equal(2, (await _blocks.ListAsync(Cancel)).Length);
    }

    [Fact]
    public async Task Expired_blocks_are_let_go_by_the_prune()
    {
        await _blocks.BlockAsync(new BlockAddressRequest("198.51.100.7", Minutes: 5), "maria", null, Cancel);
        await _blocks.BlockAsync(new BlockAddressRequest("198.51.100.8"), "maria", null, Cancel);
        _clock.Advance(TimeSpan.FromMinutes(6));

        var pruned = await _blocks.PruneExpiredAsync(Cancel);

        Assert.Equal(1, pruned);
        Assert.DoesNotContain("198.51.100.7", BlockedFile, StringComparison.Ordinal);
        Assert.Contains("198.51.100.8", BlockedFile, StringComparison.Ordinal);
        Assert.Equal(0, await _blocks.PruneExpiredAsync(Cancel));
    }

    [Fact]
    public async Task Blocking_marks_the_addresses_attack_events_as_blocked()
    {
        await using (var db = await _database.Contexts.CreateDbContextAsync(Cancel))
        {
            db.AttackEvents.Add(new AttackEvent { SiteId = "app", Kind = AttackKind.Scan, Address = "198.51.100.7", FirstSeenAt = 1, LastSeenAt = 2, Count = 3 });
            await db.SaveChangesAsync(Cancel);
        }

        await _blocks.BlockAsync(new BlockAddressRequest("198.51.100.7"), "maria", null, Cancel);

        await using var check = await _database.Contexts.CreateDbContextAsync(Cancel);
        Assert.True((await check.AttackEvents.SingleAsync(Cancel)).Blocked);
    }

    [Fact]
    public async Task The_file_is_rewritten_from_the_database_on_start()
    {
        await _blocks.BlockAsync(new BlockAddressRequest("198.51.100.7"), "maria", null, Cancel);
        _kit.Machine.WriteText(_kit.Layout.BlockListFile, BlockList.Render([]));

        var outcome = await _blocks.SyncAsync(Cancel);

        Assert.True(outcome.Applied);
        Assert.Contains("198.51.100.7", BlockedFile, StringComparison.Ordinal);
    }
}
