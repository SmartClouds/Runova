using Microsoft.AspNetCore.DataProtection;
using Runova.Website.Api.Accounts;

namespace Runova.Website.Tests.Accounts;

public sealed class DemoTokensTests
{
    private readonly EphemeralDataProtectionProvider _protection = new();
    private readonly Clock _clock = new(new DateTimeOffset(2026, 11, 22, 9, 0, 0, TimeSpan.Zero));

    private DemoTokens Tokens() => new(_protection, _clock);

    [Fact]
    public void An_access_token_reads_back_until_its_15_minutes_are_up()
    {
        var tokens = Tokens();
        var access = tokens.AccessToken();

        Assert.StartsWith("rdm1.", access, StringComparison.Ordinal);
        Assert.True(tokens.IsAccessToken(access));

        _clock.Now += TimeSpan.FromMinutes(14);
        Assert.True(tokens.IsAccessToken(access));

        _clock.Now += TimeSpan.FromMinutes(2);
        Assert.False(tokens.IsAccessToken(access));
    }

    [Fact]
    public void A_refresh_token_reads_back_for_30_days()
    {
        var tokens = Tokens();
        var refresh = tokens.RefreshToken();

        Assert.StartsWith("rrm1.", refresh, StringComparison.Ordinal);
        _clock.Now += TimeSpan.FromDays(29);
        Assert.True(tokens.IsRefreshToken(refresh));

        _clock.Now += TimeSpan.FromDays(2);
        Assert.False(tokens.IsRefreshToken(refresh));
    }

    [Fact]
    public void An_access_token_is_never_a_refresh_token_and_back()
    {
        var tokens = Tokens();

        Assert.False(tokens.IsRefreshToken(tokens.AccessToken()));
        Assert.False(tokens.IsAccessToken(tokens.RefreshToken()));
        Assert.False(tokens.IsRefreshToken("rrm1." + tokens.AccessToken()["rdm1.".Length..]));
        Assert.False(tokens.IsAccessToken("rdm1." + tokens.RefreshToken()["rrm1.".Length..]));
    }

    [Fact]
    public void A_device_token_never_reads_as_a_demo_token_and_back()
    {
        var demo = Tokens();
        var device = new DeviceTokens(_protection);
        var deviceAccess = device.AccessToken(5, 7);
        var demoAccess = demo.AccessToken();

        Assert.False(demo.IsAccessToken(deviceAccess));
        Assert.False(demo.IsAccessToken("rdm1." + deviceAccess["rd1.".Length..]));
        Assert.Null(device.Read(demoAccess));
        Assert.Null(device.Read("rd1." + demoAccess["rdm1.".Length..]));
    }

    [Theory]
    [InlineData("")]
    [InlineData("rdm1.")]
    [InlineData("rdm1.not-a-token")]
    [InlineData("Bearer rdm1.x")]
    public void Anything_else_is_not_a_demo_token(string token)
    {
        Assert.False(Tokens().IsAccessToken(token));
        Assert.False(Tokens().IsRefreshToken(token));
    }

    [Fact]
    public void A_changed_token_is_refused()
    {
        var tokens = Tokens();
        var access = tokens.AccessToken();
        var last = access[^1];
        var tampered = access[..^1] + (last == 'A' ? 'B' : 'A');

        Assert.False(tokens.IsAccessToken(tampered));
    }

    [Fact]
    public void A_token_from_another_key_ring_is_refused()
    {
        var access = Tokens().AccessToken();

        Assert.False(new DemoTokens(new EphemeralDataProtectionProvider(), _clock).IsAccessToken(access));
    }

    [Fact]
    public void Issuing_gives_the_demo_account_a_fresh_pair()
    {
        var tokens = Tokens();

        var first = tokens.Issue();
        var second = tokens.Issue();

        Assert.True(tokens.IsAccessToken(first.AccessToken));
        Assert.True(tokens.IsRefreshToken(first.RefreshToken));
        Assert.NotEqual(first.AccessToken, second.AccessToken);
        Assert.NotEqual(first.RefreshToken, second.RefreshToken);
        Assert.Equal(900, first.ExpiresIn);
        Assert.Equal(-1, first.SessionId);
        Assert.Equal(-1, first.Account.Id);
        Assert.Equal("Demo", first.Account.DisplayName);
        Assert.Equal("demo@runovahq.com", first.Account.Email);
    }

    [Fact]
    public void The_demo_principal_is_an_account_with_no_role()
    {
        var principal = DemoAccount.Principal();

        Assert.True(principal.Identity?.IsAuthenticated);
        Assert.True(DemoAccount.IsDemo(principal));
        Assert.Equal("-1", principal.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value);
        Assert.False(principal.IsInRole("Admin"));
        Assert.False(principal.IsInRole("Editor"));
        Assert.False(Runova.Website.Api.ApiClients.ApiClientPrincipal.IsApiClient(principal));
        Assert.False(DemoAccount.IsDemo(DeviceTokens.Principal(1, 2)));
        Assert.False(DemoAccount.IsDemo(null));
    }

    private sealed class Clock(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = now;

        public override DateTimeOffset GetUtcNow() => Now;
    }
}
